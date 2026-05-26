import { createAutopilotExecutionPreview, type AutopilotExecutionPreview } from "./autopilot-execution-preview";

export type AutopilotDryRunExecution = {
  planId: string;
  status: "validated" | "blocked";
  checks: Array<{
    label: string;
    ok: boolean;
    detail: string;
  }>;
  operations: Array<{
    label: string;
    detail: string;
  }>;
  telegramSummary: string;
};

function statusIcon(ok: boolean) {
  return ok ? "OK" : "BLOCKED";
}

function needsSwap(preview: AutopilotExecutionPreview) {
  return preview.steps.some((step) => step.label === "Prepare partial swap");
}

function buildTelegramSummary(execution: Omit<AutopilotDryRunExecution, "telegramSummary">) {
  return [
    "Executor dry run",
    `Plan id: ${execution.planId}`,
    `Status: ${execution.status}`,
    "",
    "Checks",
    ...execution.checks.map((check) => `${statusIcon(check.ok)} ${check.label}: ${check.detail}`),
    "",
    "Prepared operations",
    ...execution.operations.map((operation, index) => `${index + 1}. ${operation.label}: ${operation.detail}`),
    "",
    "Execution mode: dry run only. No on-chain transactions were sent."
  ].join("\n");
}

export function buildAutopilotDryRunExecution(preview: AutopilotExecutionPreview): AutopilotDryRunExecution {
  const swapRequired = needsSwap(preview);
  const quoteAvailable = !swapRequired || preview.quote.status === "available";
  const checks = [
    {
      label: "Preview readiness",
      ok: preview.status === "ready",
      detail: preview.status === "ready" ? "Execution preview passed all guardrails" : `Preview blocked by ${preview.reasons.join(", ")}`
    },
    {
      label: "Quote readiness",
      ok: quoteAvailable,
      detail: quoteAvailable ? "Required quote is available" : "Required swap quote is unavailable; retry before execution"
    },
    {
      label: "Transaction submission",
      ok: true,
      detail: "Disabled for this executor step"
    }
  ];
  const operations = preview.steps.map((step) => ({
    label: step.label,
    detail: step.detail
  }));
  const executionWithoutTelegram = {
    planId: preview.planId,
    status: checks.every((check) => check.ok) ? ("validated" as const) : ("blocked" as const),
    checks,
    operations
  };

  return {
    ...executionWithoutTelegram,
    telegramSummary: buildTelegramSummary(executionWithoutTelegram)
  };
}

export async function createAutopilotDryRunExecution(planId: string) {
  const preview = await createAutopilotExecutionPreview(planId);
  return buildAutopilotDryRunExecution(preview);
}
