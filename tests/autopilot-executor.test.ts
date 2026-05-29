import { describe, expect, it } from "vitest";
import { buildAutopilotDryRunExecution } from "@/lib/autopilot-executor";
import { type AutopilotExecutionPreview } from "@/lib/autopilot-execution-preview";
import { CONTRACTS } from "@/lib/constants";

function preview(input: Partial<AutopilotExecutionPreview> = {}): AutopilotExecutionPreview {
  return {
    planId: "plan",
    status: "ready",
    title: "Execution preview ready",
    pool: {
      currentTick: -199687,
      price: 2128.81
    },
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
        type: "close",
        label: "Close/review stale range",
        sourceLabel: "Review stale range #5187240",
        detail: "Close and swap WETH to USDC for the new lower guard",
        estimatedCostUsd: 3.88,
        tokenId: "5187240"
      },
      {
        type: "mint",
        label: "Prepare mint",
        sourceLabel: "Mint lower guard",
        detail: "Target ticks -199920 - -199860, budget $2,464.26.",
        estimatedCostUsd: 3.88,
        lowerTick: -199920,
        upperTick: -199860,
        budgetUsd: 2464.26
      },
      {
        type: "partial_swap",
        label: "Prepare partial swap",
        sourceLabel: "Use partial swap only",
        detail: "Estimated immediate cost is $3.88; current reversal debt is $0.",
        estimatedCostUsd: 3.88,
        quoteRequest: {
          tokenIn: "0x4200000000000000000000000000000000000006",
          tokenOut: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
          fee: 3000,
          amountIn: 1,
          spendSymbol: "WETH",
          receiveSymbol: "USDC"
        }
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
        source: "Uniswap QuoterV2",
        sourceType: "uniswap_v3",
        executable: true,
        executionNote: "Executable by the current Uniswap-only rebalancer contract."
      }
    },
    telegramSummary: "summary",
    ...input
  };
}

function smallCapitalPreview(input: Partial<AutopilotExecutionPreview> = {}): AutopilotExecutionPreview {
  return preview({
    steps: [
      {
        type: "close",
        label: "Close current test range",
        sourceLabel: "Close current test range #1",
        detail: "Close the current single test range before minting -199800 - -199560.",
        estimatedCostUsd: 1.6,
        tokenId: "1"
      },
      {
        type: "partial_swap",
        label: "Rebalance token split",
        sourceLabel: "Rebalance token split",
        detail: "Swap toward the required split for -199800 - -199560.",
        estimatedCostUsd: 1.6,
        quoteRequest: {
          tokenIn: CONTRACTS.usdc,
          tokenOut: CONTRACTS.weth,
          fee: 3000,
          amountIn: 400,
          spendSymbol: "USDC",
          receiveSymbol: "WETH"
        }
      },
      {
        type: "mint",
        label: "Mint next 240-tick range",
        sourceLabel: "Mint next 240-tick range",
        detail: "Target ticks -199800 - -199560, budget $1,000.",
        estimatedCostUsd: 1.6,
        lowerTick: -199800,
        upperTick: -199560,
        budgetUsd: 1000
      }
    ],
    quote: {
      status: "available",
      data: {
        tokenIn: CONTRACTS.usdc,
        tokenOut: CONTRACTS.weth,
        fee: 3000,
        amountIn: 400,
        spendSymbol: "USDC",
        receiveSymbol: "WETH",
        amountInRaw: "400000000",
        amountOut: 0.19,
        amountOutRaw: "190000000000000000",
        effectivePrice: 2105,
        gasEstimate: "72044",
        source: "Uniswap QuoterV2",
        sourceType: "uniswap_v3",
        executable: true,
        executionNote: "Executable by the current Uniswap-only rebalancer contract."
      }
    },
    ...input
  });
}

describe("buildAutopilotDryRunExecution", () => {
  it("validates a ready preview with a required quote", () => {
    const execution = buildAutopilotDryRunExecution(preview(), {
      rebalancerRoles: {
        status: "roles_match",
        detail: "Rebalancer roles match configured executor and vault"
      }
    });

    expect(execution.status).toBe("validated");
    expect(execution.telegramSummary).toContain("Executor dry run");
    expect(execution.telegramSummary).toContain("Status: validated");
    expect(execution.intents).toHaveLength(3);
    expect(execution.intents.map((intent) => intent.kind)).toEqual(["close_position", "swap_exact_input", "mint_position"]);
    expect(execution.calls.map((call) => call.status)).toEqual(["blocked", "prepared", "blocked"]);
    expect(execution.calls[1].functionName).toBe("exactInputSingle");
    expect(execution.telegramSummary).toContain("Calldata / simulation");
    expect(execution.telegramSummary).toContain("Atomic rebalancer");
    expect(execution.telegramSummary).toContain("eth_call simulation");
    expect(execution.telegramSummary).toContain("Close position #5187240");
    expect(execution.telegramSummary).toContain("Swap 1 WETH");
    expect(execution.telegramSummary).toContain("via Uniswap QuoterV2");
    expect(execution.telegramSummary).toContain("Mint -199920 - -199860");
    expect(execution.telegramSummary).toContain("No on-chain transactions were sent.");
  });

  it("prepares simulation-only close calldata when live position state is available", () => {
    const execution = buildAutopilotDryRunExecution(preview(), {
      closePositions: {
        "5187240": {
          status: "available",
          tokenId: "5187240",
          liquidity: 123n,
          tokensOwed0: 4n,
          tokensOwed1: 5n,
          decreaseAmount0: 2_000_000_000_000_000_000n,
          decreaseAmount1: 0n
        }
      }
    });

    expect(execution.calls.map((call) => call.functionName)).toEqual(["decreaseLiquidity", "collect", "exactInputSingle", null]);
    expect(execution.calls.slice(0, 2).map((call) => call.status)).toEqual(["prepared", "prepared"]);
    expect(execution.telegramSummary).toContain("close_position.decreaseLiquidity");
    expect(execution.telegramSummary).toContain("Simulation-only calldata prepared for full live liquidity 123");
  });

  it("prepares atomic rebalancer calldata when close, swap, and mint params are available", () => {
    const execution = buildAutopilotDryRunExecution(preview(), {
      closePositions: {
        "5187240": {
          status: "available",
          tokenId: "5187240",
          liquidity: 123n,
          tokensOwed0: 4n,
          tokensOwed1: 5n,
          decreaseAmount0: 2_000_000_000_000_000_000n,
          decreaseAmount1: 0n
        }
      }
    });

    expect(execution.atomicCall.status).toBe("prepared");
    expect(execution.atomicCall.functionName).toBe("rebalance");
    expect(execution.atomicCall.dataPreview).toMatch(/^0x/);
    expect(execution.telegramSummary).toContain("Single-call contract calldata prepared");
  });

  it("blocks live readiness when checked NFT approval is unavailable", () => {
    const execution = buildAutopilotDryRunExecution(preview(), {
      closePositions: {
        "5187240": {
          status: "available",
          tokenId: "5187240",
          liquidity: 123n,
          tokensOwed0: 4n,
          tokensOwed1: 5n,
          decreaseAmount0: 2_000_000_000_000_000_000n,
          decreaseAmount1: 0n
        }
      },
      nftApprovals: {
        "5187240": {
          status: "unavailable",
          tokenId: "5187240",
          detail: "AUTOPILOT_REBALANCER_ADDRESS is not configured"
        }
      },
      rebalancerAddress: ""
    });

    expect(execution.status).toBe("blocked");
    expect(execution.telegramSummary).toContain("BLOCKED Rebalancer contract");
  });

  it("reports ready NFT approval in the atomic rebalancer message", () => {
    const execution = buildAutopilotDryRunExecution(preview(), {
      closePositions: {
        "5187240": {
          status: "available",
          tokenId: "5187240",
          liquidity: 123n,
          tokensOwed0: 4n,
          tokensOwed1: 5n,
          decreaseAmount0: 2_000_000_000_000_000_000n,
          decreaseAmount1: 0n
        }
      },
      nftApprovals: {
        "5187240": {
          status: "approved",
          tokenId: "5187240",
          detail: "Rebalancer is approved for this NFT"
        }
      },
      rebalancerRoles: {
        status: "roles_match",
        detail: "Rebalancer roles match configured executor and vault"
      },
      rebalancerAddress: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0"
    });

    expect(execution.telegramSummary).toContain("NFT approval is ready");
    expect(execution.telegramSummary).not.toContain("requires NFT approval");
  });

  it("prepares simulation-only mint calldata when allowances cover desired amounts", () => {
    const execution = buildAutopilotDryRunExecution(preview(), {
      allowances: {
        [`${CONTRACTS.weth.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`]: 10n ** 30n,
        [`${CONTRACTS.usdc.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`]: 10n ** 30n
      },
      rebalancerRoles: {
        status: "roles_match",
        detail: "Rebalancer roles match configured executor and vault"
      }
    });

    const swapCall = execution.calls.find((call) => call.functionName === "exactInputSingle");
    const mintCall = execution.calls.find((call) => call.functionName === "mint");
    expect(swapCall?.status).toBe("prepared");
    expect(mintCall?.status).toBe("prepared");
    expect(execution.telegramSummary).toContain("amount0Desired");
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

  it("builds single-range close, swap, and mint intents for the small-capital preset", () => {
    const execution = buildAutopilotDryRunExecution(smallCapitalPreview(), {
      closePositions: {
        "1": {
          status: "available",
          tokenId: "1",
          liquidity: 123n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
          decreaseAmount0: 300_000_000_000_000_000n,
          decreaseAmount1: 600_000_000n
        }
      },
      allowances: {
        [`${CONTRACTS.weth.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`]: 10n ** 30n,
        [`${CONTRACTS.usdc.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`]: 10n ** 30n
      },
      rebalancerRoles: {
        status: "roles_match",
        detail: "Rebalancer roles match configured executor and vault"
      }
    });

    expect(execution.status).toBe("validated");
    expect(execution.intents.map((intent) => intent.kind)).toEqual(["close_position", "swap_exact_input", "mint_position"]);
    expect(execution.calls.some((call) => call.functionName === "decreaseLiquidity")).toBe(true);
    expect(execution.calls.some((call) => call.functionName === "exactInputSingle")).toBe(true);
    expect(execution.calls.some((call) => call.functionName === "mint")).toBe(true);
    expect(execution.telegramSummary).toContain("Mint -199800 - -199560");
  });

  it("blocks atomic execution when the rebalancer roles do not match the configured wallets", () => {
    const execution = buildAutopilotDryRunExecution(smallCapitalPreview(), {
      closePositions: {
        "1": {
          status: "available",
          tokenId: "1",
          liquidity: 123n,
          tokensOwed0: 0n,
          tokensOwed1: 0n,
          decreaseAmount0: 300_000_000_000_000_000n,
          decreaseAmount1: 600_000_000n
        }
      },
      nftApprovals: {
        "1": {
          status: "approved",
          tokenId: "1",
          detail: "Rebalancer is approved for this NFT"
        }
      },
      rebalancerRoles: {
        status: "roles_mismatch",
        detail: "Rebalancer owner 0x6C28F2F5908F61f2F698c504664f777482859FA7; executor 0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45 does not match AUTOPILOT_EXECUTOR_ADDRESS 0x6C28F2F5908F61f2F698c504664f777482859FA7; vault 0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45 does not match BASE_WALLET_ADDRESS 0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057"
      },
      allowances: {
        [`${CONTRACTS.weth.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`]: 10n ** 30n,
        [`${CONTRACTS.usdc.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`]: 10n ** 30n
      }
    });

    expect(execution.status).toBe("blocked");
    expect(execution.telegramSummary).toContain("BLOCKED Rebalancer roles");
    expect(execution.telegramSummary).toContain("does not match AUTOPILOT_EXECUTOR_ADDRESS");
    expect(execution.telegramSummary).toContain("does not match BASE_WALLET_ADDRESS");
  });
});
