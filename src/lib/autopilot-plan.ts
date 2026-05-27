import { type Position, type Transaction } from "@prisma/client";
import { type Address } from "viem";
import { CONTRACTS } from "./constants";
import { priceFromTick, WETH_USDC_NARROW_FEE, WETH_USDC_NARROW_TICK_SPACING } from "./narrow-range-rebalance";
import { calculateTripleRangeGuide, type TripleRangeGuide } from "./triple-range-guide";

export type AutopilotMode = "manual" | "approve_in_telegram" | "auto_guarded" | "auto_full";
export type AutopilotPreset = "triple_range" | "small_capital_test";
export type AutopilotState = "idle" | "armed" | "confirming" | "ready" | "cooldown" | "paused";
export type AutopilotSeverity = "good" | "warn" | "bad";

export type AutopilotPlan = {
  mode: AutopilotMode;
  state: AutopilotState;
  severity: AutopilotSeverity;
  title: string;
  detail: string;
  strategy: {
    preset: AutopilotPreset;
    label: string;
    targetWidthTicks: number;
    confirmationSeconds: number;
    maxDriftBps: number;
    maxImmediateCostUsd: number;
    maxUncoveredDebtUsd: number;
    feeCreditMustCoverCosts: boolean;
  };
  pool: {
    currentTick: number;
    baseTick: number;
    price: number;
    triggerBufferPercent: number;
    reverseBufferPercent: number;
    confirmationMinutes: number;
    cooldownMinutes: number;
  };
  economics: {
    immediateCostUsd: number;
    estimatedSlippageUsd: number;
    estimatedGasUsd: number;
    reversalDebtUsd: number;
    feeCreditUsd: number;
    collectedFeesSinceLastSwapUsd: number;
    uncollectedFeesUsd: number;
    uncoveredReversalDebtUsd: number;
    feesNeededToReverseUsd: number;
    lastDirectionalSwap: DirectionalSwap | null;
  };
  ladder: Array<{
    role: "lower" | "active" | "upper";
    range: string;
    lowerTick: number;
    upperTick: number;
    lowerPrice: number | null;
    upperPrice: number | null;
    tokenId: string | null;
    status: string;
    plannedAction: string;
  }>;
  actions: Array<{
    type: "hold" | "wait" | "close" | "partial_swap" | "mint" | "pause";
    label: string;
    detail: string;
    estimatedCostUsd: number;
    tokenId?: string;
    lowerTick?: number;
    upperTick?: number;
    budgetUsd?: number;
    quoteRequest?: {
      tokenIn: Address;
      tokenOut: Address;
      fee: number;
      amountIn: number;
      spendSymbol: "WETH" | "USDC";
      receiveSymbol: "WETH" | "USDC";
    };
  }>;
  telegramSummary: string;
  updatedAt: string;
};

type DirectionalSwap = {
  timestamp: string;
  side: "buy_weth" | "sell_weth";
  wethAmount: number;
  usdcAmount: number;
  effectivePrice: number;
  hash: string;
  protocol: string | null;
};

type TokenAmountLike = {
  symbol?: string;
  amount?: string;
  direction?: string;
};

const DEFAULT_MODE: AutopilotMode = "approve_in_telegram";
const DEFAULT_PRESET: AutopilotPreset = "triple_range";
const TRIGGER_BUFFER_PERCENT = 0.1;
const REVERSE_BUFFER_PERCENT = 0.15;
const CONFIRMATION_MINUTES = 5;
const COOLDOWN_MINUTES = 20;
const ESTIMATED_SLIPPAGE_PERCENT = 0.15;
const ESTIMATED_GAS_USD = 0.1;
const SMALL_CAPITAL_WIDTH_TICKS = 240;
const SMALL_CAPITAL_CONFIRM_SECONDS = 30;
const SMALL_CAPITAL_MAX_DRIFT_BPS = 30;
const SMALL_CAPITAL_MAX_IMMEDIATE_COST_USD = 5;

function strategyConfig(preset: AutopilotPreset): AutopilotPlan["strategy"] {
  if (preset === "small_capital_test") {
    return {
      preset,
      label: "Small capital test",
      targetWidthTicks: SMALL_CAPITAL_WIDTH_TICKS,
      confirmationSeconds: SMALL_CAPITAL_CONFIRM_SECONDS,
      maxDriftBps: SMALL_CAPITAL_MAX_DRIFT_BPS,
      maxImmediateCostUsd: SMALL_CAPITAL_MAX_IMMEDIATE_COST_USD,
      maxUncoveredDebtUsd: 0,
      feeCreditMustCoverCosts: true
    };
  }

  return {
    preset,
    label: "Triple range",
    targetWidthTicks: WETH_USDC_NARROW_TICK_SPACING,
    confirmationSeconds: CONFIRMATION_MINUTES * 60,
    maxDriftBps: 30,
    maxImmediateCostUsd: 10,
    maxUncoveredDebtUsd: 10,
    feeCreditMustCoverCosts: false
  };
}

function numericAmount(value?: string | null) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatPrice(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

function tokenAmount(value: unknown, symbol: "WETH" | "USDC", direction?: "in" | "out") {
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, item) => {
    if (!item || typeof item !== "object") return sum;
    const amount = item as TokenAmountLike;
    if (amount.symbol !== symbol || (direction && amount.direction !== direction)) return sum;
    const parsed = Number(amount.amount);
    return Number.isFinite(parsed) ? sum + parsed : sum;
  }, 0);
}

function directionalSwap(transaction: Pick<Transaction, "timestamp" | "hash" | "protocol" | "tokenAmounts">): DirectionalSwap | null {
  const wethIn = tokenAmount(transaction.tokenAmounts, "WETH", "in");
  const wethOut = tokenAmount(transaction.tokenAmounts, "WETH", "out");
  const usdcIn = tokenAmount(transaction.tokenAmounts, "USDC", "in");
  const usdcOut = tokenAmount(transaction.tokenAmounts, "USDC", "out");
  const wethAmount = wethIn + wethOut;
  const usdcAmount = usdcIn + usdcOut;

  if (wethAmount <= 0 || usdcAmount <= 0) return null;

  return {
    timestamp: transaction.timestamp.toISOString(),
    side: wethIn > 0 ? "buy_weth" : "sell_weth",
    wethAmount,
    usdcAmount,
    effectivePrice: usdcAmount / wethAmount,
    hash: transaction.hash,
    protocol: transaction.protocol
  };
}

function latestDirectionalSwap(transactions: Pick<Transaction, "timestamp" | "hash" | "protocol" | "tokenAmounts" | "type">[]) {
  for (const transaction of transactions) {
    if (transaction.type !== "swap") continue;
    const swap = directionalSwap(transaction);
    if (swap) return swap;
  }
  return null;
}

function collectedFeesSinceLastSwapUsd(
  transactions: Pick<Transaction, "timestamp" | "tokenAmounts" | "type">[],
  lastSwap: DirectionalSwap | null,
  currentPrice: number
) {
  if (!lastSwap) return 0;
  const checkpoint = new Date(lastSwap.timestamp).getTime();
  return transactions.reduce((sum, transaction) => {
    if (transaction.type !== "lp_collect" || transaction.timestamp.getTime() <= checkpoint) return sum;
    const weth = tokenAmount(transaction.tokenAmounts, "WETH");
    const usdc = tokenAmount(transaction.tokenAmounts, "USDC");
    return sum + weth * currentPrice + usdc;
  }, 0);
}

function reversalDebtUsd(lastSwap: DirectionalSwap | null, currentPrice: number) {
  if (!lastSwap || currentPrice <= 0) return 0;
  if (lastSwap.side === "buy_weth") {
    return Math.max(0, (lastSwap.effectivePrice - currentPrice) * lastSwap.wethAmount);
  }
  return Math.max(0, (currentPrice - lastSwap.effectivePrice) * lastSwap.wethAmount);
}

function positionValueUsd(position: Pick<Position, "wethAmount" | "usdcAmount">, price: number) {
  return numericAmount(position.wethAmount) * price + numericAmount(position.usdcAmount);
}

function estimateSwapNotionalUsd(guide: TripleRangeGuide) {
  const missingBudget = guide.segments
    .filter((segment) => segment.state === "missing")
    .reduce((sum, segment) => sum + segment.targetUsd, 0);
  const staleBudget = guide.leftovers.reduce((sum, position) => sum + position.valueUsd, 0);
  const driftBudget = guide.segments
    .filter((segment) => segment.state === "warn" && segment.position)
    .reduce((sum, segment) => sum + Math.abs((segment.position?.valueUsd ?? 0) - segment.targetUsd), 0);

  return Math.max(missingBudget, staleBudget, driftBudget);
}

function plannedActionForSegment(segment: TripleRangeGuide["segments"][number]) {
  if (!segment.position) return "Mint missing range";
  if (segment.state === "warn") return "Resize only if economics pass";
  return "Leave untouched";
}

function activeNarrowPositions(positions: Position[]) {
  return positions.filter((position) => position.fee === WETH_USDC_NARROW_FEE && position.status !== "closed_or_zero_liquidity" && position.liquidity !== "0");
}

function allActiveOutOfRange(positions: Position[]) {
  const active = activeNarrowPositions(positions);
  return active.length > 0 && active.every((position) => position.status === "above_range" || position.status === "below_range");
}

function alignToSpacing(tick: number) {
  return Math.floor(tick / WETH_USDC_NARROW_TICK_SPACING) * WETH_USDC_NARROW_TICK_SPACING;
}

function singleRangeTarget(currentTick: number, widthTicks: number) {
  const intervals = widthTicks / WETH_USDC_NARROW_TICK_SPACING;
  const baseTick = alignToSpacing(currentTick);
  const lowerTick = baseTick - Math.floor(intervals / 2) * WETH_USDC_NARROW_TICK_SPACING;
  return {
    lowerTick,
    upperTick: lowerTick + widthTicks
  };
}

function desiredTokenAmountsForRange(params: { price: number; lowerTick: number; upperTick: number; budgetUsd: number; token0: Address; token1: Address }) {
  if (params.budgetUsd <= 0 || params.price <= 0) return { weth: 0, usdc: 0 };
  if (params.upperTick <= params.lowerTick) return { weth: 0, usdc: 0 };

  const lowerPrice = priceFromTick({
    tick: params.lowerTick,
    token0: params.token0,
    token1: params.token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  const upperPrice = priceFromTick({
    tick: params.upperTick,
    token0: params.token0,
    token1: params.token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  if (!lowerPrice || !upperPrice || lowerPrice <= 0 || upperPrice <= lowerPrice) return { weth: 0, usdc: 0 };

  if (params.price <= lowerPrice) return { weth: params.budgetUsd / params.price, usdc: 0 };
  if (params.price >= upperPrice) return { weth: 0, usdc: params.budgetUsd };

  const sqrtPrice = Math.sqrt(params.price);
  const sqrtLower = Math.sqrt(lowerPrice);
  const sqrtUpper = Math.sqrt(upperPrice);
  const usdcPerWethRatio = (sqrtPrice * sqrtUpper * (sqrtPrice - sqrtLower)) / (sqrtUpper - sqrtPrice);
  const weth = params.budgetUsd / (params.price + usdcPerWethRatio);
  return {
    weth,
    usdc: params.budgetUsd - weth * params.price
  };
}

function singleRangeSwapQuoteRequest(params: {
  totalWeth: number;
  totalUsdc: number;
  desiredWeth: number;
  desiredUsdc: number;
}): AutopilotPlan["actions"][number]["quoteRequest"] {
  const wethExcess = params.totalWeth - params.desiredWeth;
  const usdcExcess = params.totalUsdc - params.desiredUsdc;
  if (wethExcess > 0.000001 && params.totalUsdc < params.desiredUsdc) {
    return {
      tokenIn: CONTRACTS.weth,
      tokenOut: CONTRACTS.usdc,
      fee: WETH_USDC_NARROW_FEE,
      amountIn: wethExcess,
      spendSymbol: "WETH",
      receiveSymbol: "USDC"
    };
  }

  if (usdcExcess > 0.01 && params.totalWeth < params.desiredWeth) {
    return {
      tokenIn: CONTRACTS.usdc,
      tokenOut: CONTRACTS.weth,
      fee: WETH_USDC_NARROW_FEE,
      amountIn: usdcExcess,
      spendSymbol: "USDC",
      receiveSymbol: "WETH"
    };
  }

  return undefined;
}

function chooseState(guide: TripleRangeGuide, positions: Position[]): AutopilotState {
  if (guide.recommendation.severity === "good") return "idle";
  if (allActiveOutOfRange(positions)) return "ready";
  if (guide.leftovers.length > 0 || guide.segments.some((segment) => segment.state === "missing")) return "confirming";
  return "armed";
}

function chooseTitle(state: AutopilotState, guide: TripleRangeGuide) {
  if (state === "idle") return "Autopilot idle";
  if (state === "ready") return "Rebalance plan ready";
  if (state === "confirming") return "Breakout confirmation";
  if (state === "armed") return "Price near action zone";
  return guide.recommendation.title;
}

function partialSwapQuoteRequest(guide: TripleRangeGuide): AutopilotPlan["actions"][number]["quoteRequest"] {
  const staleLower = guide.leftovers.find((leftover) => leftover.suggestedUse.includes("WETH to USDC"));
  const staleUpper = guide.leftovers.find((leftover) => leftover.suggestedUse.includes("USDC to WETH"));
  const missingLowerBudget = guide.segments.find((segment) => segment.role === "lower" && segment.state === "missing")?.targetUsd ?? 0;
  const missingUpperBudget = guide.segments.find((segment) => segment.role === "upper" && segment.state === "missing")?.targetUsd ?? 0;

  if (staleLower && staleLower.weth > 0 && missingLowerBudget > 0) {
    return {
      tokenIn: CONTRACTS.weth,
      tokenOut: CONTRACTS.usdc,
      fee: WETH_USDC_NARROW_FEE,
      amountIn: Math.min(staleLower.weth, missingLowerBudget / guide.pool.price),
      spendSymbol: "WETH",
      receiveSymbol: "USDC"
    };
  }

  if (staleUpper && staleUpper.usdc > 0 && missingUpperBudget > 0) {
    return {
      tokenIn: CONTRACTS.usdc,
      tokenOut: CONTRACTS.weth,
      fee: WETH_USDC_NARROW_FEE,
      amountIn: Math.min(staleUpper.usdc, missingUpperBudget),
      spendSymbol: "USDC",
      receiveSymbol: "WETH"
    };
  }

  return undefined;
}

function buildActions(guide: TripleRangeGuide, immediateCostUsd: number, reversalDebt: number): AutopilotPlan["actions"] {
  if (guide.recommendation.severity === "good") {
    return [{ type: "hold", label: "Hold current ladder", detail: "All three ranges are present and close to target.", estimatedCostUsd: 0 }];
  }

  const actions: AutopilotPlan["actions"] = [];
  for (const leftover of guide.leftovers) {
    actions.push({
      type: "close",
      label: `Review stale range #${leftover.tokenId}`,
      detail: leftover.suggestedUse,
      estimatedCostUsd: immediateCostUsd,
      tokenId: leftover.tokenId
    });
  }
  for (const segment of guide.segments.filter((item) => item.state === "missing")) {
    actions.push({
      type: "mint",
      label: `Mint ${segment.label.toLowerCase()}`,
      detail: `Target ticks ${segment.lowerTick} - ${segment.upperTick}, budget ${formatUsd(segment.targetUsd)}.`,
      estimatedCostUsd: immediateCostUsd,
      lowerTick: segment.lowerTick,
      upperTick: segment.upperTick,
      budgetUsd: segment.targetUsd
    });
  }
  if (immediateCostUsd > 0) {
    const quoteRequest = partialSwapQuoteRequest(guide);
    actions.push({
      type: "partial_swap",
      label: "Use partial swap only",
      detail: `Estimated immediate cost is ${formatUsd(immediateCostUsd)}; current reversal debt is ${formatUsd(reversalDebt)}.`,
      estimatedCostUsd: immediateCostUsd,
      quoteRequest
    });
  }

  if (actions.length === 0) {
    actions.push({ type: "wait", label: "Wait for confirmation", detail: guide.recommendation.detail, estimatedCostUsd: 0 });
  }

  return actions;
}

function buildTelegramSummary(plan: Omit<AutopilotPlan, "telegramSummary">) {
  const firstAction = plan.actions[0];
  return [
    plan.title,
    `Strategy: ${plan.strategy.label} (${plan.strategy.targetWidthTicks} ticks, ${plan.strategy.confirmationSeconds}s confirm, ${plan.strategy.maxDriftBps} bps drift max)`,
    `State: ${plan.state}`,
    `Price: ${formatPrice(plan.pool.price)} USDC | Tick ${plan.pool.currentTick}`,
    `Next: ${firstAction?.label ?? "No action"}`,
    `Immediate cost: ${formatUsd(plan.economics.immediateCostUsd)}`,
    `Reversal debt: ${formatUsd(plan.economics.reversalDebtUsd)}`,
    `Fee credit: ${formatUsd(plan.economics.feeCreditUsd)}`,
    `Uncovered debt: ${formatUsd(plan.economics.uncoveredReversalDebtUsd)}`,
    `Auto mode: ${plan.mode}`
  ].join("\n");
}

function calculateSmallCapitalPlan(params: {
  positions: Position[];
  transactions: Pick<Transaction, "timestamp" | "hash" | "protocol" | "tokenAmounts" | "type">[];
  walletWeth: number | null;
  walletUsdc: number | null;
  currentTick: number;
  token0: Address;
  token1: Address;
  mode?: AutopilotMode;
  updatedAt?: Date;
  uncollectedFeeCreditUsd?: number;
}): AutopilotPlan {
  const price = priceFromTick({
    tick: params.currentTick,
    token0: params.token0,
    token1: params.token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  if (!price) throw new Error("Unable to calculate WETH/USDC pool price");

  const strategy = strategyConfig("small_capital_test");
  const activePositions = activeNarrowPositions(params.positions);
  const inRange = activePositions.find((position) => position.tickLower <= params.currentTick && params.currentTick < position.tickUpper) ?? null;
  const preferredPosition =
    inRange ??
    activePositions
      .map((position) => ({
        position,
        distance: Math.min(Math.abs(params.currentTick - position.tickLower), Math.abs(params.currentTick - position.tickUpper))
      }))
      .sort((left, right) => left.distance - right.distance)[0]?.position ??
    null;
  const target = singleRangeTarget(params.currentTick, strategy.targetWidthTicks);
  const targetLowerPrice = priceFromTick({
    tick: target.lowerTick,
    token0: params.token0,
    token1: params.token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  const targetUpperPrice = priceFromTick({
    tick: target.upperTick,
    token0: params.token0,
    token1: params.token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  const activeValueUsd = activePositions.reduce((sum, position) => sum + positionValueUsd(position, price), 0);
  const walletValueUsd = (params.walletWeth ?? 0) * price + (params.walletUsdc ?? 0);
  const portfolioValueUsd = activeValueUsd + walletValueUsd;
  const selectedPositionValueUsd = preferredPosition ? positionValueUsd(preferredPosition, price) : 0;
  const executionBudgetUsd = Math.max(selectedPositionValueUsd + walletValueUsd, portfolioValueUsd);
  const totalWeth = (params.walletWeth ?? 0) + (preferredPosition ? numericAmount(preferredPosition.wethAmount) : 0);
  const totalUsdc = (params.walletUsdc ?? 0) + (preferredPosition ? numericAmount(preferredPosition.usdcAmount) : 0);
  const desired = desiredTokenAmountsForRange({
    price,
    lowerTick: target.lowerTick,
    upperTick: target.upperTick,
    budgetUsd: executionBudgetUsd,
    token0: params.token0,
    token1: params.token1
  });
  const quoteRequest = singleRangeSwapQuoteRequest({
    totalWeth,
    totalUsdc,
    desiredWeth: desired.weth,
    desiredUsdc: desired.usdc
  });
  const currentWidth = preferredPosition ? preferredPosition.tickUpper - preferredPosition.tickLower : null;
  const isTargetRange =
    preferredPosition?.tickLower === target.lowerTick &&
    preferredPosition?.tickUpper === target.upperTick &&
    currentWidth === strategy.targetWidthTicks;
  const hasExtraPositions = activePositions.length > 1;
  const shouldHoldCurrentRange =
    preferredPosition?.status === "in_range" && currentWidth === strategy.targetWidthTicks && !hasExtraPositions;
  const lastSwap = latestDirectionalSwap(params.transactions);
  const debt = reversalDebtUsd(lastSwap, price);
  const collectedFeeCredit = collectedFeesSinceLastSwapUsd(params.transactions, lastSwap, price);
  const uncollectedFeeCredit = params.uncollectedFeeCreditUsd ?? 0;
  const feeCredit = collectedFeeCredit + uncollectedFeeCredit;
  const swapNotionalUsd = quoteRequest ? (quoteRequest.spendSymbol === "WETH" ? quoteRequest.amountIn * price : quoteRequest.amountIn) : 0;
  const estimatedSlippageUsd = preferredPosition && !isTargetRange && !shouldHoldCurrentRange ? swapNotionalUsd * (ESTIMATED_SLIPPAGE_PERCENT / 100) : 0;
  const immediateCostUsd = preferredPosition && !isTargetRange && !shouldHoldCurrentRange ? estimatedSlippageUsd + ESTIMATED_GAS_USD : 0;
  const uncoveredReversalDebtUsd = Math.max(0, debt + immediateCostUsd - feeCredit);
  const mode = params.mode ?? DEFAULT_MODE;
  const targetRange = `${target.lowerTick} - ${target.upperTick}`;
  const ladder: AutopilotPlan["ladder"] = [
    {
      role: "active",
      range: preferredPosition ? `${preferredPosition.tickLower} - ${preferredPosition.tickUpper}` : targetRange,
      lowerTick: preferredPosition?.tickLower ?? target.lowerTick,
      upperTick: preferredPosition?.tickUpper ?? target.upperTick,
      lowerPrice: preferredPosition
        ? priceFromTick({ tick: preferredPosition.tickLower, token0: params.token0, token1: params.token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc })
        : targetLowerPrice,
      upperPrice: preferredPosition
        ? priceFromTick({ tick: preferredPosition.tickUpper, token0: params.token0, token1: params.token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc })
        : targetUpperPrice,
      tokenId: preferredPosition?.tokenId ?? null,
      status: preferredPosition ? ((isTargetRange && !hasExtraPositions) || shouldHoldCurrentRange ? "ok" : "warn") : "missing",
      plannedAction:
        (isTargetRange && !hasExtraPositions) || shouldHoldCurrentRange
          ? "Keep current 240-tick test range until breakout"
          : "Do not build guard ranges; prepare one 240-tick range"
    }
  ];
  const actions: AutopilotPlan["actions"] = [];

  if (isTargetRange && !hasExtraPositions) {
    actions.push({
      type: "hold",
      label: "Hold single test range",
      detail: "The active position matches the 240-tick small-capital test preset.",
      estimatedCostUsd: 0
    });
  } else if (shouldHoldCurrentRange) {
    actions.push({
      type: "hold",
      label: "Hold current in-range test range",
      detail: `Current range ${preferredPosition.tickLower} - ${preferredPosition.tickUpper} still contains price; do not recenter until breakout.`,
      estimatedCostUsd: 0,
      tokenId: preferredPosition.tokenId
    });
  } else if (!preferredPosition && portfolioValueUsd > 0) {
    actions.push({
      type: "mint",
      label: "Mint one 240-tick range",
      detail: `Target ticks ${targetRange}, using the test budget only.`,
      estimatedCostUsd: 0,
      lowerTick: target.lowerTick,
      upperTick: target.upperTick,
      budgetUsd: portfolioValueUsd
    });
  } else {
    if (preferredPosition) {
      actions.push({
        type: "close",
        label: `Close current test range #${preferredPosition.tokenId}`,
        detail: `Close the current single test range before minting ${targetRange}.`,
        estimatedCostUsd: immediateCostUsd,
        tokenId: preferredPosition.tokenId
      });
    }
    if (quoteRequest) {
      actions.push({
        type: "partial_swap",
        label: "Rebalance token split",
        detail: `Swap toward the required split for ${targetRange}: target ${desired.weth.toLocaleString("en-US", { maximumFractionDigits: 6 })} WETH and ${desired.usdc.toLocaleString("en-US", { maximumFractionDigits: 2 })} USDC.`,
        estimatedCostUsd: immediateCostUsd,
        quoteRequest
      });
    }
    actions.push({
      type: "mint",
      label: "Mint next 240-tick range",
      detail: `Target ticks ${targetRange}, budget ${formatUsd(executionBudgetUsd)}.`,
      estimatedCostUsd: immediateCostUsd,
      lowerTick: target.lowerTick,
      upperTick: target.upperTick,
      budgetUsd: executionBudgetUsd
    });
  }

  const state: AutopilotState = (isTargetRange && !hasExtraPositions) || shouldHoldCurrentRange ? "idle" : "confirming";
  const title = state === "idle" ? "Small test range active" : "Small-capital plan";
  const detail =
    state === "idle"
      ? "One 240-tick range is active. Guard ranges are disabled for the $1k test."
      : "Guard ranges are disabled. Use one 240-tick range and rebalance only after fee credit covers costs.";

  const planWithoutTelegram = {
    mode,
    state,
    severity: state === "idle" ? ("good" as const) : ("warn" as const),
    title,
    detail,
    strategy,
    pool: {
      currentTick: params.currentTick,
      baseTick: alignToSpacing(params.currentTick),
      price,
      triggerBufferPercent: TRIGGER_BUFFER_PERCENT,
      reverseBufferPercent: REVERSE_BUFFER_PERCENT,
      confirmationMinutes: strategy.confirmationSeconds / 60,
      cooldownMinutes: COOLDOWN_MINUTES
    },
    economics: {
      immediateCostUsd,
      estimatedSlippageUsd,
      estimatedGasUsd: immediateCostUsd > 0 ? ESTIMATED_GAS_USD : 0,
      reversalDebtUsd: debt,
      feeCreditUsd: feeCredit,
      collectedFeesSinceLastSwapUsd: collectedFeeCredit,
      uncollectedFeesUsd: uncollectedFeeCredit,
      uncoveredReversalDebtUsd,
      feesNeededToReverseUsd: uncoveredReversalDebtUsd,
      lastDirectionalSwap: lastSwap
    },
    ladder,
    actions,
    updatedAt: (params.updatedAt ?? new Date()).toISOString()
  };

  return {
    ...planWithoutTelegram,
    telegramSummary: buildTelegramSummary(planWithoutTelegram)
  };
}

export function calculateAutopilotPlan(params: {
  positions: Position[];
  transactions: Pick<Transaction, "timestamp" | "hash" | "protocol" | "tokenAmounts" | "type">[];
  walletWeth: number | null;
  walletUsdc: number | null;
  currentTick: number;
  token0: Address;
  token1: Address;
  mode?: AutopilotMode;
  preset?: AutopilotPreset;
  baselineAt?: Date | null;
  updatedAt?: Date;
  uncollectedFeeCreditUsd?: number;
}): AutopilotPlan {
  const transactions =
    params.baselineAt && params.preset === "small_capital_test"
      ? params.transactions.filter((transaction) => transaction.timestamp.getTime() >= params.baselineAt!.getTime())
      : params.transactions;

  if ((params.preset ?? DEFAULT_PRESET) === "small_capital_test") {
    return calculateSmallCapitalPlan({
      positions: params.positions,
      transactions,
      walletWeth: params.walletWeth,
      walletUsdc: params.walletUsdc,
      currentTick: params.currentTick,
      token0: params.token0,
      token1: params.token1,
      mode: params.mode,
      updatedAt: params.updatedAt,
      uncollectedFeeCreditUsd: params.baselineAt ? 0 : params.uncollectedFeeCreditUsd
    });
  }

  const price = priceFromTick({
    tick: params.currentTick,
    token0: params.token0,
    token1: params.token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });

  if (!price) throw new Error("Unable to calculate WETH/USDC pool price");

  const guide = calculateTripleRangeGuide({
    positions: params.positions,
    walletWeth: params.walletWeth,
    walletUsdc: params.walletUsdc,
    currentTick: params.currentTick,
    price,
    token0: params.token0,
    token1: params.token1,
    updatedAt: params.updatedAt
  });
  const lastSwap = latestDirectionalSwap(transactions);
  const debt = reversalDebtUsd(lastSwap, price);
  const collectedFeeCredit = collectedFeesSinceLastSwapUsd(transactions, lastSwap, price);
  const uncollectedFeeCredit = params.uncollectedFeeCreditUsd ?? 0;
  const feeCredit = collectedFeeCredit + uncollectedFeeCredit;
  const swapNotionalUsd = estimateSwapNotionalUsd(guide);
  const estimatedSlippageUsd = swapNotionalUsd * (ESTIMATED_SLIPPAGE_PERCENT / 100);
  const immediateCostUsd = swapNotionalUsd > 0 ? estimatedSlippageUsd + ESTIMATED_GAS_USD : 0;
  const uncoveredReversalDebtUsd = Math.max(0, debt + immediateCostUsd - feeCredit);
  const state = chooseState(guide, params.positions);
  const severity = guide.recommendation.severity;
  const actions = buildActions(guide, immediateCostUsd, debt);
  const mode = params.mode ?? DEFAULT_MODE;
  const strategy = strategyConfig("triple_range");

  const planWithoutTelegram = {
    mode,
    state,
    severity,
    strategy,
    title: chooseTitle(state, guide),
    detail:
      state === "ready"
        ? "The ladder is no longer aligned with the current pool interval. Execute only after the confirmation and reversal-debt checks pass."
        : guide.recommendation.detail,
    pool: {
      currentTick: params.currentTick,
      baseTick: guide.pool.baseTick,
      price,
      triggerBufferPercent: TRIGGER_BUFFER_PERCENT,
      reverseBufferPercent: REVERSE_BUFFER_PERCENT,
      confirmationMinutes: CONFIRMATION_MINUTES,
      cooldownMinutes: COOLDOWN_MINUTES
    },
    economics: {
      immediateCostUsd,
      estimatedSlippageUsd,
      estimatedGasUsd: swapNotionalUsd > 0 ? ESTIMATED_GAS_USD : 0,
      reversalDebtUsd: debt,
      feeCreditUsd: feeCredit,
      collectedFeesSinceLastSwapUsd: collectedFeeCredit,
      uncollectedFeesUsd: uncollectedFeeCredit,
      uncoveredReversalDebtUsd,
      feesNeededToReverseUsd: uncoveredReversalDebtUsd,
      lastDirectionalSwap: lastSwap
    },
    ladder: guide.segments.map((segment) => ({
      role: segment.role,
      range: `${segment.lowerTick} - ${segment.upperTick}`,
      lowerTick: segment.lowerTick,
      upperTick: segment.upperTick,
      lowerPrice: segment.lowerPrice,
      upperPrice: segment.upperPrice,
      tokenId: segment.position?.tokenId ?? null,
      status: segment.state,
      plannedAction: plannedActionForSegment(segment)
    })),
    actions,
    updatedAt: (params.updatedAt ?? new Date()).toISOString()
  };

  return {
    ...planWithoutTelegram,
    telegramSummary: buildTelegramSummary(planWithoutTelegram)
  };
}

export function estimateCurrentActiveValueUsd(positions: Position[], price: number) {
  return activeNarrowPositions(positions).reduce((sum, position) => sum + positionValueUsd(position, price), 0);
}
