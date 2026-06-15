import { type RebalancePlan } from "@/generated/prisma/client";
import { type AutopilotPlan } from "./autopilot-plan";
import { autopilotPlanKey, getCurrentAutopilotPlan } from "./autopilot-service";
import { prisma } from "./db";
import { quoteBestExecutableSwap, type SwapQuote, type SwapQuoteRequest } from "./swap-quote";

export type AutopilotExecutionPreview = {
  planId: string;
  status: "ready" | "blocked";
  title: string;
  pool: {
    currentTick: number;
    price: number;
  };
  strategy: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>["strategy"];
  reasons: string[];
  checks: Array<{
    label: string;
    ok: boolean;
    detail: string;
  }>;
  steps: Array<{
    type: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>["actions"][number]["type"];
    label: string;
    sourceLabel: string;
    detail: string;
    estimatedCostUsd: number;
    tokenId?: string;
    lowerTick?: number;
    upperTick?: number;
    budgetUsd?: number;
    quoteRequest?: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>["actions"][number]["quoteRequest"];
  }>;
  quote: SwapQuoteResult;
  telegramSummary: string;
};

export type SwapQuoteResult =
  | { status: "not_requested" }
  | { status: "available"; data: SwapQuote }
  | { status: "unavailable"; request: SwapQuoteRequest; reason: string };

export type AutopilotExecutionPreviewOptions = {
  allowUncoveredDebt?: boolean;
  allowBoundaryDrift?: boolean;
  allowEquivalentPlanFreshness?: boolean;
};

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function statusIcon(ok: boolean) {
  return ok ? "OK" : "BLOCKED";
}

function redactSensitiveRpcText(message: string) {
  return message
    .replace(/https:\/\/base-mainnet\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]+/g, "https://base-mainnet.g.alchemy.com/v2/[redacted]")
    .replace(/https:\/\/[^/\s]+\/v2\/[A-Za-z0-9_-]+/g, "https://[rpc-redacted]/v2/[redacted]");
}

function shortError(error: unknown) {
  const message = redactSensitiveRpcText(error instanceof Error ? error.message : String(error));
  if (message.includes("Status: 429") || message.toLowerCase().includes("too many requests")) {
    return "RPC rate limit while requesting quote. Try approving again in a few minutes.";
  }
  if (message.length <= 180) return message;
  return `${message.slice(0, 177)}...`;
}

function actionStepLabel(type: string) {
  if (type === "close") return "Close/review stale range";
  if (type === "partial_swap") return "Prepare partial swap";
  if (type === "mint") return "Prepare mint";
  if (type === "hold") return "Hold";
  if (type === "wait") return "Wait";
  return type;
}

function boundaryDrift(plan: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>) {
  const activeRange = plan.ladder.find((segment) => segment.role === "active");
  if (!activeRange || !Number.isFinite(plan.strategy.maxDriftBps)) {
    return { ok: true, detail: "No active range boundary drift to check" };
  }

  const currentPrice = plan.pool.price;
  if (plan.pool.currentTick < activeRange.lowerTick) {
    if (activeRange.lowerPrice === null) return { ok: true, detail: "No lower boundary price available for drift check" };
    const boundaryPrice = activeRange.lowerPrice;
    const driftBps = Math.abs(((boundaryPrice - currentPrice) / boundaryPrice) * 10_000);
    return {
      ok: driftBps <= plan.strategy.maxDriftBps,
      driftBps,
      detail: `${driftBps.toFixed(1)} bps below lower boundary ${formatUsd(boundaryPrice)}; limit ${plan.strategy.maxDriftBps} bps`
    };
  }

  if (plan.pool.currentTick >= activeRange.upperTick) {
    if (activeRange.upperPrice === null) return { ok: true, detail: "No upper boundary price available for drift check" };
    const boundaryPrice = activeRange.upperPrice;
    const driftBps = Math.abs(((currentPrice - boundaryPrice) / boundaryPrice) * 10_000);
    return {
      ok: driftBps <= plan.strategy.maxDriftBps,
      driftBps,
      detail: `${driftBps.toFixed(1)} bps above upper boundary ${formatUsd(boundaryPrice)}; limit ${plan.strategy.maxDriftBps} bps`
    };
  }

  return { ok: true, driftBps: 0, detail: `Inside active range; limit ${plan.strategy.maxDriftBps} bps` };
}

function executableActions(plan: AutopilotPlan) {
  return plan.actions.filter((action) => action.type !== "hold" && action.type !== "wait");
}

function actionSignature(action: AutopilotPlan["actions"][number]) {
  return {
    type: action.type,
    tokenId: action.tokenId ?? null,
    lowerTick: action.lowerTick ?? null,
    upperTick: action.upperTick ?? null,
    quoteRequest: action.quoteRequest
      ? {
          tokenIn: action.quoteRequest.tokenIn.toLowerCase(),
          tokenOut: action.quoteRequest.tokenOut.toLowerCase(),
          fee: action.quoteRequest.fee,
          spendSymbol: action.quoteRequest.spendSymbol,
          receiveSymbol: action.quoteRequest.receiveSymbol
        }
      : null
  };
}

function activeRange(plan: AutopilotPlan) {
  return plan.ladder.find((segment) => segment.role === "active") ?? null;
}

function breakoutSide(plan: AutopilotPlan) {
  const active = activeRange(plan);
  if (!active) return null;
  if (plan.pool.currentTick < active.lowerTick) return "below";
  if (plan.pool.currentTick >= active.upperTick) return "above";
  return "inside";
}

function sameJson(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isAutopilotPlan(value: unknown): value is AutopilotPlan {
  if (!value || typeof value !== "object") return false;
  const plan = value as Partial<AutopilotPlan>;
  return Boolean(plan.pool && plan.strategy && Array.isArray(plan.ladder) && Array.isArray(plan.actions));
}

function equivalentExecutionEnvelope(savedPlan: unknown, currentPlan: AutopilotPlan) {
  if (!isAutopilotPlan(savedPlan)) {
    return { ok: false, detail: "Saved plan snapshot is unavailable for auto freshness envelope" };
  }

  const savedActive = activeRange(savedPlan);
  const currentActive = activeRange(currentPlan);
  if (!savedActive || !currentActive) {
    return { ok: false, detail: "Active range is missing from saved or current plan" };
  }

  const sameActiveRange =
    savedActive.tokenId === currentActive.tokenId &&
    savedActive.lowerTick === currentActive.lowerTick &&
    savedActive.upperTick === currentActive.upperTick;
  if (!sameActiveRange) {
    return { ok: false, detail: "Active NFT or active range changed since approval" };
  }

  const savedSide = breakoutSide(savedPlan);
  const currentSide = breakoutSide(currentPlan);
  if (savedSide === "inside" || currentSide === "inside" || savedSide !== currentSide) {
    return { ok: false, detail: "Breakout direction changed or price returned inside the active range" };
  }

  const savedActions = executableActions(savedPlan).map(actionSignature);
  const currentActions = executableActions(currentPlan).map(actionSignature);
  if (!sameJson(savedActions, currentActions)) {
    return { ok: false, detail: "Executable rebalance actions changed since approval" };
  }

  return {
    ok: true,
    detail: `Live plan changed, but auto execution envelope still matches: ${currentSide} breakout, NFT #${currentActive.tokenId}, target actions unchanged`
  };
}

function buildTelegramSummary(preview: Omit<AutopilotExecutionPreview, "telegramSummary">) {
  const quoteText =
    preview.quote.status === "available"
      ? [
          `${preview.quote.data.source}: ${preview.quote.data.amountIn.toLocaleString("en-US", { maximumFractionDigits: preview.quote.data.spendSymbol === "USDC" ? 2 : 6 })} ${preview.quote.data.spendSymbol}`,
          `-> ${preview.quote.data.amountOut.toLocaleString("en-US", { maximumFractionDigits: preview.quote.data.receiveSymbol === "USDC" ? 2 : 6 })} ${preview.quote.data.receiveSymbol}`,
          `Effective WETH price: ${formatUsd(preview.quote.data.effectivePrice)}`,
          `Gas estimate: ${preview.quote.data.gasEstimate}`,
          preview.quote.data.routeSummary ? `Route: ${preview.quote.data.routeSummary}` : undefined,
          preview.quote.data.executionNote
        ]
          .filter((line) => line !== undefined)
          .join("\n")
      : preview.quote.status === "unavailable"
        ? `Quote unavailable: ${preview.quote.reason}`
        : "No quote request in this plan.";

  return [
    "Execution preview (dry run)",
    `Plan id: ${preview.planId}`,
    `Status: ${preview.status}`,
    preview.reasons.length > 0 ? `Reason: ${preview.reasons.join("; ")}` : undefined,
    "",
    "Checks",
    ...preview.checks.map((check) => `${statusIcon(check.ok)} ${check.label}: ${check.detail}`),
    "",
    "Steps",
    ...preview.steps.map((step, index) => `${index + 1}. ${step.label}: ${step.detail}`),
    "",
    "Quote",
    quoteText,
    "",
    "No on-chain transactions were sent."
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function buildAutopilotExecutionPreview(
  record: Pick<RebalancePlan, "id" | "status" | "planKey"> & { payload?: unknown },
  currentPlanKey: string,
  currentPlan: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>,
  quote: SwapQuoteResult = { status: "not_requested" },
  options: AutopilotExecutionPreviewOptions = {}
) {
  const isApproved = record.status === "approved" || record.status === "executing";
  const freshnessEnvelope = currentPlanKey === record.planKey ? null : equivalentExecutionEnvelope(record.payload, currentPlan);
  const isFresh = currentPlanKey === record.planKey || (Boolean(options.allowEquivalentPlanFreshness) && freshnessEnvelope?.ok === true);
  const hasAction = currentPlan.actions.some((action) => action.type !== "hold" && action.type !== "wait");
  const costOk = currentPlan.economics.immediateCostUsd <= currentPlan.strategy.maxImmediateCostUsd;
  const uncoveredDebtWithinLimit = currentPlan.economics.uncoveredReversalDebtUsd <= currentPlan.strategy.maxUncoveredDebtUsd;
  const uncoveredDebtOk = uncoveredDebtWithinLimit || Boolean(options.allowUncoveredDebt);
  const boundaryDriftCheck = boundaryDrift(currentPlan);
  const boundaryDriftOk = boundaryDriftCheck.ok || Boolean(options.allowBoundaryDrift);
  const strategyAllowsExecution = currentPlan.strategy.preset !== "small_capital_test" || currentPlan.actions.some((action) => action.type === "close" || action.type === "mint");
  const notIdle = currentPlan.state !== "idle";

  const checks = [
    {
      label: "Approval",
      ok: isApproved,
      detail:
        record.status === "executing"
          ? "Telegram approval recorded; live execution is in progress"
          : isApproved
            ? "Telegram approval recorded"
            : `Plan status is ${record.status}`
    },
    {
      label: "Live plan freshness",
      ok: isFresh,
      detail:
        currentPlanKey === record.planKey
          ? "Live plan still matches approved snapshot"
          : isFresh
            ? (freshnessEnvelope?.detail ?? "Live plan changed, but auto execution envelope still matches")
            : (freshnessEnvelope?.detail ?? "Live plan changed; request a new approval")
    },
    {
      label: "Action required",
      ok: hasAction && notIdle,
      detail: hasAction && notIdle ? currentPlan.title : "No executable rebalance action in the current plan"
    },
    {
      label: "Immediate cost",
      ok: costOk,
      detail: `${formatUsd(currentPlan.economics.immediateCostUsd)} <= ${formatUsd(currentPlan.strategy.maxImmediateCostUsd)}`
    },
    {
      label: "Uncovered debt",
      ok: uncoveredDebtOk,
      detail: uncoveredDebtWithinLimit
        ? `${formatUsd(currentPlan.economics.uncoveredReversalDebtUsd)} <= ${formatUsd(currentPlan.strategy.maxUncoveredDebtUsd)} after ${formatUsd(currentPlan.economics.feeCreditUsd)} fee credit`
        : options.allowUncoveredDebt
          ? `${formatUsd(currentPlan.economics.uncoveredReversalDebtUsd)} accepted by user; normal limit ${formatUsd(currentPlan.strategy.maxUncoveredDebtUsd)} after ${formatUsd(currentPlan.economics.feeCreditUsd)} fee credit`
          : `${formatUsd(currentPlan.economics.uncoveredReversalDebtUsd)} <= ${formatUsd(currentPlan.strategy.maxUncoveredDebtUsd)} after ${formatUsd(currentPlan.economics.feeCreditUsd)} fee credit`
    },
    {
      label: "Boundary drift",
      ok: boundaryDriftOk,
      detail: boundaryDriftCheck.ok
        ? boundaryDriftCheck.detail
        : options.allowBoundaryDrift
          ? `${boundaryDriftCheck.detail}; accepted by user`
          : boundaryDriftCheck.detail
    },
    {
      label: "Strategy preset",
      ok: strategyAllowsExecution,
      detail:
        currentPlan.strategy.preset === "small_capital_test"
          ? "Small-capital mode blocks the old three-range executor until a single-range rebalance path is prepared"
          : currentPlan.strategy.label
    }
  ];
  const reasons = checks.filter((check) => !check.ok).map((check) => check.label);
  const steps = currentPlan.actions.map((action) => ({
    type: action.type,
    label: actionStepLabel(action.type),
    sourceLabel: action.label,
    detail: action.detail,
    estimatedCostUsd: action.estimatedCostUsd,
    tokenId: action.tokenId,
    lowerTick: action.lowerTick,
    upperTick: action.upperTick,
    budgetUsd: action.budgetUsd,
    quoteRequest: action.quoteRequest
  }));
  const previewWithoutTelegram = {
    planId: record.id,
    status: reasons.length === 0 ? ("ready" as const) : ("blocked" as const),
    title: reasons.length === 0 ? "Execution preview ready" : "Execution preview blocked",
    pool: {
      currentTick: currentPlan.pool.currentTick,
      price: currentPlan.pool.price
    },
    strategy: currentPlan.strategy,
    reasons,
    checks,
    steps,
    quote
  };

  return {
    ...previewWithoutTelegram,
    telegramSummary: buildTelegramSummary(previewWithoutTelegram)
  };
}

export async function createAutopilotExecutionPreview(
  planId: string,
  options: AutopilotExecutionPreviewOptions = {}
): Promise<AutopilotExecutionPreview> {
  const record = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
  if (!record) throw new Error("Rebalance plan not found");

  const currentPlan = await getCurrentAutopilotPlan();
  const quoteRequest = currentPlan.actions.find((action) => action.type === "partial_swap" && action.quoteRequest)?.quoteRequest;
  const quote: SwapQuoteResult = quoteRequest
    ? await quoteBestExecutableSwap(quoteRequest)
        .then((data): SwapQuoteResult => ({ status: "available", data }))
        .catch((error): SwapQuoteResult => ({ status: "unavailable", request: quoteRequest, reason: shortError(error) }))
    : { status: "not_requested" };
  return buildAutopilotExecutionPreview(record, autopilotPlanKey(currentPlan), currentPlan, quote, options);
}
