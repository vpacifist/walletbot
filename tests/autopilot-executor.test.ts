import { describe, expect, it } from "vitest";
import { buildAutopilotDryRunExecution } from "@/lib/autopilot-executor";
import { type AutopilotExecutionPreview } from "@/lib/autopilot-execution-preview";

function preview(input: Partial<AutopilotExecutionPreview> = {}): AutopilotExecutionPreview {
  return {
    planId: "plan",
    status: "ready",
    title: "Execution preview ready",
    reasons: [],
    checks: [
      {
        label: "Approval",
        ok: true,
        detail: "Telegram approval recorded"
      }
    ],
    steps: [
      {
        label: "Close/review stale range",
        detail: "Close and swap WETH to USDC for the new lower guard"
      },
      {
        label: "Prepare partial swap",
        detail: "Estimated immediate cost is $3.88; current reversal debt is $0."
      }
    ],
    quote: {
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
        gasEstimate: "72044",
        source: "Uniswap QuoterV2"
      }
    },
    telegramSummary: "summary",
    ...input
  };
}

describe("buildAutopilotDryRunExecution", () => {
  it("validates a ready preview with a required quote", () => {
    const execution = buildAutopilotDryRunExecution(preview());

    expect(execution.status).toBe("validated");
    expect(execution.telegramSummary).toContain("Executor dry run");
    expect(execution.telegramSummary).toContain("Status: validated");
    expect(execution.telegramSummary).toContain("No on-chain transactions were sent.");
  });

  it("blocks execution when a required quote is unavailable", () => {
    const execution = buildAutopilotDryRunExecution(
      preview({
        quote: {
          status: "unavailable",
          request: {
            tokenIn: "0x4200000000000000000000000000000000000006",
            tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
            fee: 3000,
            amountIn: 1,
            spendSymbol: "WETH",
            receiveSymbol: "USDC"
          },
          reason: "RPC rate limit"
        }
      })
    );

    expect(execution.status).toBe("blocked");
    expect(execution.telegramSummary).toContain("BLOCKED Quote readiness");
  });

  it("blocks execution when preview guardrails are blocked", () => {
    const execution = buildAutopilotDryRunExecution(
      preview({
        status: "blocked",
        reasons: ["Live plan freshness"]
      })
    );

    expect(execution.status).toBe("blocked");
    expect(execution.telegramSummary).toContain("Preview blocked by Live plan freshness");
  });
});
