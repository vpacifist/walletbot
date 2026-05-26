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
      feeCreditUsd: 0,
      collectedFeesSinceLastSwapUsd: 0,
      uncollectedFeesUsd: 0,
      uncoveredReversalDebtUsd: 3,
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
    expect(preview.telegramSummary).toContain("No quote request in this plan.");
    expect(preview.telegramSummary).toContain("No on-chain transactions were sent.");
  });

  it("blocks stale approved plans", () => {
    const preview = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "old" }, "new", plan());

    expect(preview.status).toBe("blocked");
    expect(preview.reasons).toContain("Live plan freshness");
  });

  it("includes quote-only output when a quote is available", () => {
    const preview = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "same" }, "same", plan(), {
      status: "available",
      data: {
        tokenIn: "0x4200000000000000000000000000000000000006",
        tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        fee: 3000,
        amountIn: 1,
        spendSymbol: "WETH",
        receiveSymbol: "USDC",
        amountInRaw: "1000000000000000000",
        amountOut: 2090,
        amountOutRaw: "2090000000",
        effectivePrice: 2090,
        gasEstimate: "120000",
        source: "Uniswap QuoterV2"
      }
    });

    expect(preview.telegramSummary).toContain("Uniswap QuoterV2");
    expect(preview.telegramSummary).toContain("Effective WETH price: $2,090");
  });

  it("keeps the preview usable when quote retrieval fails", () => {
    const preview = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "same" }, "same", plan(), {
      status: "unavailable",
      request: {
        tokenIn: "0x4200000000000000000000000000000000000006",
        tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        fee: 3000,
        amountIn: 1,
        spendSymbol: "WETH",
        receiveSymbol: "USDC"
      },
      reason: "RPC rate limit while requesting quote. Try approving again in a few minutes."
    });

    expect(preview.status).toBe("ready");
    expect(preview.telegramSummary).toContain("Quote unavailable");
    expect(preview.telegramSummary).toContain("No on-chain transactions were sent.");
  });
});
