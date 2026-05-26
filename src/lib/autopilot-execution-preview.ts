import { type RebalancePlan } from "@prisma/client";
import { autopilotPlanKey, getCurrentAutopilotPlan } from "./autopilot-service";
import { prisma } from "./db";
import { quoteExactInputSingle, type SwapQuote, type SwapQuoteRequest } from "./uniswap-v3-quoter";

export type AutopilotExecutionPreview = {
  planId: string;
  status: "ready" | "blocked";
  title: string;
  pool: {
    currentTick: number;
    price: number;
  };
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

const MAX_IMMEDIATE_COST_USD = 10;
const MAX_UNCOVERED_DEBT_USD = 10;

export type SwapQuoteResult =
  | { status: "not_requested" }
  | { status: "available"; data: SwapQuote }
  | { status: "unavailable"; request: SwapQuoteRequest; reason: string };

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function statusIcon(ok: boolean) {
  return ok ? "OK" : "BLOCKED";
}

function shortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
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

function buildTelegramSummary(preview: Omit<AutopilotExecutionPreview, "telegramSummary">) {
  const quoteText =
    preview.quote.status === "available"
      ? [
          `${preview.quote.data.source}: ${preview.quote.data.amountIn.toLocaleString("en-US", { maximumFractionDigits: preview.quote.data.spendSymbol === "USDC" ? 2 : 6 })} ${preview.quote.data.spendSymbol}`,
          `-> ${preview.quote.data.amountOut.toLocaleString("en-US", { maximumFractionDigits: preview.quote.data.receiveSymbol === "USDC" ? 2 : 6 })} ${preview.quote.data.receiveSymbol}`,
          `Effective WETH price: ${formatUsd(preview.quote.data.effectivePrice)}`,
          `Gas estimate: ${preview.quote.data.gasEstimate}`
        ].join("\n")
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
  record: Pick<RebalancePlan, "id" | "status" | "planKey">,
  currentPlanKey: string,
  currentPlan: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>,
  quote: SwapQuoteResult = { status: "not_requested" }
) {
  const isApproved = record.status === "approved";
  const isFresh = currentPlanKey === record.planKey;
  const hasAction = currentPlan.actions.some((action) => action.type !== "hold" && action.type !== "wait");
  const costOk = currentPlan.economics.immediateCostUsd <= MAX_IMMEDIATE_COST_USD;
  const uncoveredDebtOk = currentPlan.economics.uncoveredReversalDebtUsd <= MAX_UNCOVERED_DEBT_USD;
  const notIdle = currentPlan.state !== "idle";

  const checks = [
    {
      label: "Approval",
      ok: isApproved,
      detail: isApproved ? "Telegram approval recorded" : `Plan status is ${record.status}`
    },
    {
      label: "Live plan freshness",
      ok: isFresh,
      detail: isFresh ? "Live plan still matches approved snapshot" : "Live plan changed; request a new approval"
    },
    {
      label: "Action required",
      ok: hasAction && notIdle,
      detail: hasAction && notIdle ? currentPlan.title : "No executable rebalance action in the current plan"
    },
    {
      label: "Immediate cost",
      ok: costOk,
      detail: `${formatUsd(currentPlan.economics.immediateCostUsd)} <= ${formatUsd(MAX_IMMEDIATE_COST_USD)}`
    },
    {
      label: "Uncovered debt",
      ok: uncoveredDebtOk,
      detail: `${formatUsd(currentPlan.economics.uncoveredReversalDebtUsd)} <= ${formatUsd(MAX_UNCOVERED_DEBT_USD)} after ${formatUsd(currentPlan.economics.feeCreditUsd)} fee credit`
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

export async function createAutopilotExecutionPreview(planId: string): Promise<AutopilotExecutionPreview> {
  const record = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
  if (!record) throw new Error("Rebalance plan not found");

  const currentPlan = await getCurrentAutopilotPlan();
  const quoteRequest = currentPlan.actions.find((action) => action.type === "partial_swap" && action.quoteRequest)?.quoteRequest;
  const quote: SwapQuoteResult = quoteRequest
    ? await quoteExactInputSingle(quoteRequest)
        .then((data): SwapQuoteResult => ({ status: "available", data }))
        .catch((error): SwapQuoteResult => ({ status: "unavailable", request: quoteRequest, reason: shortError(error) }))
    : { status: "not_requested" };
  return buildAutopilotExecutionPreview(record, autopilotPlanKey(currentPlan), currentPlan, quote);
}
