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
    strategy: {
      preset: "triple_range",
      label: "Triple range",
      targetWidthTicks: 60,
      confirmationSeconds: 300,
      maxDriftBps: 30,
      maxImmediateCostUsd: 10,
      maxUncoveredDebtUsd: 10,
      feeCreditMustCoverCosts: false
    },
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
        source: "Uniswap QuoterV2",
        sourceType: "uniswap_v3",
        executable: true,
        executionNote: "Executable by the current Uniswap-only rebalancer contract."
      }
    });

    expect(preview.telegramSummary).toContain("Uniswap QuoterV2");
    expect(preview.telegramSummary).toContain("Executable by the current Uniswap-only rebalancer contract.");
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

  it("blocks the old executor for a small-capital wait plan", () => {
    const preview = buildAutopilotExecutionPreview(
      { id: "plan", status: "approved", planKey: "same" },
      "same",
      plan({
        strategy: {
          preset: "small_capital_test",
          label: "Small capital test",
          targetWidthTicks: 240,
          confirmationSeconds: 30,
          maxDriftBps: 30,
          maxImmediateCostUsd: 5,
          maxUncoveredDebtUsd: 0,
          feeCreditMustCoverCosts: true
        },
        actions: [{ type: "wait", label: "Wait for single-range executor", detail: "Small-capital mode blocks the old three-range rebalance.", estimatedCostUsd: 0 }]
      })
    );

    expect(preview.status).toBe("blocked");
    expect(preview.reasons).toContain("Action required");
    expect(preview.reasons).toContain("Strategy preset");
  });

  it("allows a bounded uncovered debt for the small-capital breakout test", () => {
    const preview = buildAutopilotExecutionPreview(
      { id: "plan", status: "approved", planKey: "same" },
      "same",
      plan({
        title: "Small-capital plan",
        strategy: {
          preset: "small_capital_test",
          label: "Small capital test",
          targetWidthTicks: 240,
          confirmationSeconds: 30,
          maxDriftBps: 30,
          maxImmediateCostUsd: 5,
          maxUncoveredDebtUsd: 1.5,
          feeCreditMustCoverCosts: false
        },
        economics: {
          immediateCostUsd: 0.93,
          estimatedSlippageUsd: 0.83,
          estimatedGasUsd: 0.1,
          reversalDebtUsd: 0,
          feeCreditUsd: 0,
          collectedFeesSinceLastSwapUsd: 0,
          uncollectedFeesUsd: 0,
          uncoveredReversalDebtUsd: 0.93,
          feesNeededToReverseUsd: 0.93,
          lastDirectionalSwap: null
        },
        actions: [
          { type: "close", label: "Close current test range #5199548", detail: "Close the current single test range.", estimatedCostUsd: 0.93, tokenId: "5199548" },
          { type: "mint", label: "Mint next 240-tick range", detail: "Target ticks -200520 - -200280.", estimatedCostUsd: 0.93, lowerTick: -200520, upperTick: -200280 }
        ]
      })
    );

    expect(preview.status).toBe("ready");
    expect(preview.reasons).not.toContain("Uncovered debt");
    expect(preview.telegramSummary).toContain("OK Uncovered debt: $0.93 <= $1.5 after $0 fee credit");
  });

  it("allows uncovered debt only when the user accepted the override", () => {
    const currentPlan = plan({
      title: "Small-capital plan",
      strategy: {
        preset: "small_capital_test",
        label: "Small capital test",
        targetWidthTicks: 240,
        confirmationSeconds: 30,
        maxDriftBps: 30,
        maxImmediateCostUsd: 5,
        maxUncoveredDebtUsd: 1.5,
        feeCreditMustCoverCosts: false
      },
      economics: {
        immediateCostUsd: 0.56,
        estimatedSlippageUsd: 0.46,
        estimatedGasUsd: 0.1,
        reversalDebtUsd: 7.82,
        feeCreditUsd: 0,
        collectedFeesSinceLastSwapUsd: 0,
        uncollectedFeesUsd: 0,
        uncoveredReversalDebtUsd: 8.39,
        feesNeededToReverseUsd: 8.39,
        lastDirectionalSwap: null
      }
    });

    const blocked = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "same" }, "same", currentPlan);
    const accepted = buildAutopilotExecutionPreview(
      { id: "plan", status: "approved", planKey: "same" },
      "same",
      currentPlan,
      { status: "not_requested" },
      { allowUncoveredDebt: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.reasons).toEqual(["Uncovered debt"]);
    expect(accepted.status).toBe("ready");
    expect(accepted.reasons).not.toContain("Uncovered debt");
    expect(accepted.telegramSummary).toContain("OK Uncovered debt: $8.39 accepted by user; normal limit $1.5 after $0 fee credit");
  });

  it("blocks boundary drift until the user accepts the override", () => {
    const currentPlan = plan({
      title: "Small-capital plan",
      strategy: {
        preset: "small_capital_test",
        label: "Small capital test",
        targetWidthTicks: 240,
        confirmationSeconds: 30,
        maxDriftBps: 30,
        maxImmediateCostUsd: 5,
        maxUncoveredDebtUsd: 1.5,
        feeCreditMustCoverCosts: false
      },
      pool: {
        currentTick: -200781,
        baseTick: -200820,
        price: 1907.45,
        triggerBufferPercent: 0.1,
        reverseBufferPercent: 0.15,
        confirmationMinutes: 0.5,
        cooldownMinutes: 20
      },
      economics: {
        immediateCostUsd: 0.93,
        estimatedSlippageUsd: 0.83,
        estimatedGasUsd: 0.1,
        reversalDebtUsd: 0,
        feeCreditUsd: 0,
        collectedFeesSinceLastSwapUsd: 0,
        uncollectedFeesUsd: 0,
        uncoveredReversalDebtUsd: 0.93,
        feesNeededToReverseUsd: 0.93,
        lastDirectionalSwap: null
      },
      ladder: [
        {
          role: "active",
          range: "-201060 - -200820",
          lowerTick: -201060,
          upperTick: -200820,
          lowerPrice: 1855.72,
          upperPrice: 1900.79,
          tokenId: "5245558",
          status: "above_range",
          plannedAction: "Close current test range"
        }
      ],
      actions: [
        { type: "close", label: "Close current test range #5245558", detail: "Close the current single test range.", estimatedCostUsd: 0.93, tokenId: "5245558" },
        { type: "mint", label: "Mint next 240-tick range", detail: "Target ticks -200820 - -200580.", estimatedCostUsd: 0.93, lowerTick: -200820, upperTick: -200580 }
      ]
    });

    const blocked = buildAutopilotExecutionPreview({ id: "plan", status: "approved", planKey: "same" }, "same", currentPlan);
    const accepted = buildAutopilotExecutionPreview(
      { id: "plan", status: "approved", planKey: "same" },
      "same",
      currentPlan,
      { status: "not_requested" },
      { allowBoundaryDrift: true }
    );

    expect(blocked.status).toBe("blocked");
    expect(blocked.reasons).toEqual(["Boundary drift"]);
    expect(blocked.telegramSummary).toContain("BLOCKED Boundary drift: 35.0 bps above upper boundary $1,900.79; limit 30 bps");
    expect(accepted.status).toBe("ready");
    expect(accepted.reasons).not.toContain("Boundary drift");
    expect(accepted.telegramSummary).toContain("OK Boundary drift: 35.0 bps above upper boundary $1,900.79; limit 30 bps; accepted by user");
  });
});
