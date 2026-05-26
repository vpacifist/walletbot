import { describe, expect, it } from "vitest";
import { buildAutopilotExecutionPreview } from "@/lib/autopilot-execution-preview";
import { type AutopilotPlan } from "@/lib/autopilot-plan";

function plan(input: Partial<AutopilotPlan> = {}): AutopilotPlan {
  return {
    mode: "approve_in_telegram",
    state: "confirming",
    severity: "bad",
    title: "Breakout confirmation",
    detail: "The current price interval changed.",
    pool: {
      currentTick: -199845,
      baseTick: -199860,
      price: 2095,
      triggerBufferPercent: 0.1,
      reverseBufferPercent: 0.15,
      confirmationMinutes: 5,
      cooldownMinutes: 20
    },
    economics: {
      immediateCostUsd: 3,
      estimatedSlippageUsd: 2.9,
      estimatedGasUsd: 0.1,
      reversalDebtUsd: 0,
      feesNeededToReverseUsd: 3,
      lastDirectionalSwap: null
    },
    ladder: [],
    actions: [{ type: "mint", label: "Mint lower guard", detail: "Target ticks -199920 - -199860.", estimatedCostUsd: 3 }],
    telegramSummary: "summary",
    updatedAt: "2026-05-26T00:00:00.000Z",
    ...input
  };
}

describe("buildAutopilotExecutionPreview", () => {
  it("marks an approved fresh plan as ready", () => {
    const preview = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "same" }, "same", plan());

    expect(preview.status).toBe("ready");
    expect(preview.telegramSummary).toContain("Status: ready");
    expect(preview.telegramSummary).toContain("No on-chain transactions were sent.");
  });

  it("blocks stale approved plans", () => {
    const preview = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "old" }, "new", plan());

    expect(preview.status).toBe("blocked");
    expect(preview.reasons).toContain("Live plan freshness");
  });
});
