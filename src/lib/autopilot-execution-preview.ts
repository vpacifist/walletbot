import { type RebalancePlan } from "@prisma/client";
import { autopilotPlanKey, getCurrentAutopilotPlan } from "./autopilot-service";
import { prisma } from "./db";
import { quoteExactInputSingle, type SwapQuote } from "./uniswap-v3-quoter";

export type AutopilotExecutionPreview = {
  planId: string;
  status: "ready" | "blocked";
  title: string;
  reasons: string[];
  checks: Array<{
    label: string;
    ok: boolean;
    detail: string;
  }>;
  steps: Array<{
    label: string;
    detail: string;
  }>;
  quote: SwapQuote | null;
  telegramSummary: string;
};

const MAX_IMMEDIATE_COST_USD = 10;
const MAX_REVERSAL_DEBT_USD = 25;

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function statusIcon(ok: boolean) {
  return ok ? "OK" : "BLOCKED";
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
    preview.quote
      ? [
          `${preview.quote.source}: ${preview.quote.amountIn.toLocaleString("en-US", { maximumFractionDigits: preview.quote.spendSymbol === "USDC" ? 2 : 6 })} ${preview.quote.spendSymbol}`,
          `-> ${preview.quote.amountOut.toLocaleString("en-US", { maximumFractionDigits: preview.quote.receiveSymbol === "USDC" ? 2 : 6 })} ${preview.quote.receiveSymbol}`,
          `Effective WETH price: ${formatUsd(preview.quote.effectivePrice)}`,
          `Gas estimate: ${preview.quote.gasEstimate}`
        ].join("\n")
      : "No quote request in this plan.",
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
  quote: SwapQuote | null = null
) {
  const isApproved = record.status === "approved";
  const isFresh = currentPlanKey === record.planKey;
  const hasAction = currentPlan.actions.some((action) => action.type !== "hold" && action.type !== "wait");
  const costOk = currentPlan.economics.immediateCostUsd <= MAX_IMMEDIATE_COST_USD;
  const reversalDebtOk = currentPlan.economics.reversalDebtUsd <= MAX_REVERSAL_DEBT_USD;
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
      label: "Reversal debt",
      ok: reversalDebtOk,
      detail: `${formatUsd(currentPlan.economics.reversalDebtUsd)} <= ${formatUsd(MAX_REVERSAL_DEBT_USD)}`
    }
  ];
  const reasons = checks.filter((check) => !check.ok).map((check) => check.label);
  const steps = currentPlan.actions.map((action) => ({
    label: actionStepLabel(action.type),
    detail: action.detail
  }));
  const previewWithoutTelegram = {
    planId: record.id,
    status: reasons.length === 0 ? ("ready" as const) : ("blocked" as const),
    title: reasons.length === 0 ? "Execution preview ready" : "Execution preview blocked",
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
  const quote = quoteRequest ? await quoteExactInputSingle(quoteRequest) : null;
  return buildAutopilotExecutionPreview(record, autopilotPlanKey(currentPlan), currentPlan, quote);
}
