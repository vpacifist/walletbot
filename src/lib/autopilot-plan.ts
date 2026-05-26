import { type Position, type Transaction } from "@prisma/client";
import { type Address } from "viem";
import { CONTRACTS } from "./constants";
import { priceFromTick, WETH_USDC_NARROW_FEE } from "./narrow-range-rebalance";
import { calculateTripleRangeGuide, type TripleRangeGuide } from "./triple-range-guide";

export type AutopilotMode = "manual" | "approve_in_telegram" | "auto_guarded" | "auto_full";
export type AutopilotState = "idle" | "armed" | "confirming" | "ready" | "cooldown" | "paused";
export type AutopilotSeverity = "good" | "warn" | "bad";

export type AutopilotPlan = {
  mode: AutopilotMode;
  state: AutopilotState;
  severity: AutopilotSeverity;
  title: string;
  detail: string;
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
const TRIGGER_BUFFER_PERCENT = 0.1;
const REVERSE_BUFFER_PERCENT = 0.15;
const CONFIRMATION_MINUTES = 5;
const COOLDOWN_MINUTES = 20;
const ESTIMATED_SLIPPAGE_PERCENT = 0.15;
const ESTIMATED_GAS_USD = 0.1;

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
      estimatedCostUsd: immediateCostUsd
    });
  }
  for (const segment of guide.segments.filter((item) => item.state === "missing")) {
    actions.push({
      type: "mint",
      label: `Mint ${segment.label.toLowerCase()}`,
      detail: `Target ticks ${segment.lowerTick} - ${segment.upperTick}, budget ${formatUsd(segment.targetUsd)}.`,
      estimatedCostUsd: immediateCostUsd
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
    `State: ${plan.state}`,
    `Price: ${formatPrice(plan.pool.price)} USDC | Tick ${plan.pool.currentTick}`,
    `Next: ${firstAction?.label ?? "No action"}`,
    `Immediate cost: ${formatUsd(plan.economics.immediateCostUsd)}`,
    `Reversal debt: ${formatUsd(plan.economics.reversalDebtUsd)}`,
    `Auto mode: ${plan.mode}`
  ].join("\n");
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
  updatedAt?: Date;
}): AutopilotPlan {
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
  const lastSwap = latestDirectionalSwap(params.transactions);
  const debt = reversalDebtUsd(lastSwap, price);
  const swapNotionalUsd = estimateSwapNotionalUsd(guide);
  const estimatedSlippageUsd = swapNotionalUsd * (ESTIMATED_SLIPPAGE_PERCENT / 100);
  const immediateCostUsd = swapNotionalUsd > 0 ? estimatedSlippageUsd + ESTIMATED_GAS_USD : 0;
  const state = chooseState(guide, params.positions);
  const severity = guide.recommendation.severity;
  const actions = buildActions(guide, immediateCostUsd, debt);
  const mode = params.mode ?? DEFAULT_MODE;

  const planWithoutTelegram = {
    mode,
    state,
    severity,
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
      feesNeededToReverseUsd: immediateCostUsd + debt,
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
