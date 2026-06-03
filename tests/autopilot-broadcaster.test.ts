/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { broadcastAutopilotRebalance } from "@/lib/autopilot-broadcaster";
import * as executor from "@/lib/autopilot-executor";
import * as chain from "@/lib/chain";
import { prisma } from "@/lib/db";

vi.mock("@/lib/db", () => {
  return {
    prisma: {
      rebalancePlan: {
        findUnique: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn()
      }
    }
  };
});

vi.mock("@/lib/autopilot-executor", () => {
  return {
    createAutopilotDryRunExecution: vi.fn()
  };
});

vi.mock("@/lib/chain", () => {
  return {
    createAutopilotExecutorWalletClient: vi.fn(),
    createBaseClient: vi.fn(),
    createBaseWalletClient: vi.fn()
  };
});

let liveExecutionEnabled = true;

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      AUTOPILOT_LIVE_EXECUTION_ENABLED: liveExecutionEnabled,
      BLOCKSCOUT_BASE_URL: "https://base.blockscout.com"
    }))
  };
});

describe("broadcastAutopilotRebalance", () => {
  beforeEach(() => {
    liveExecutionEnabled = true;
    vi.clearAllMocks();
  });

  it("executes successfully and updates the plan state on-chain", async () => {
    // 1. Mock database findUnique
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      planKey: "test-key",
      status: "approved",
      mode: "approve_in_telegram",
      state: "ready",
      title: "Plan is ready",
      summary: "summary",
      payload: {},
      telegramChatId: null,
      telegramMessageId: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);

    // 2. Mock dry-run executor
    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "validated",
      checks: [{ label: "mock check", ok: true, detail: "detail" }],
      operations: [],
      intents: [],
      calls: [],
      atomicCall: {
        status: "prepared",
        target: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
        functionName: "rebalance",
        data: "0x12345678",
        dataPreview: "0x1234...5678",
        reason: "mock preparation successful"
      },
      telegramSummary: "dry run success"
    });

    // 3. Mock wallet client and public client
    const mockSendTransaction = vi.fn().mockResolvedValue("0xmocktxhash");
    const mockWalletClient = {
      sendTransaction: mockSendTransaction,
      chain: { id: 8453 },
      account: { address: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45" }
    };
    vi.mocked(chain.createAutopilotExecutorWalletClient).mockReturnValue(mockWalletClient as any);

    const mockWaitForTransactionReceipt = vi.fn().mockResolvedValue({
      status: "success",
      transactionHash: "0xmocktxhash",
      gasUsed: 120000n
    });
    const mockCall = vi.fn().mockResolvedValue("0x");
    const mockEstimateGas = vi.fn().mockResolvedValue(100000n);
    const mockPublicClient = {
      call: mockCall,
      estimateGas: mockEstimateGas,
      waitForTransactionReceipt: mockWaitForTransactionReceipt
    };
    vi.mocked(chain.createBaseClient).mockReturnValue(mockPublicClient as any);

    // 4. Run execution
    const result = await broadcastAutopilotRebalance("test-plan-id");

    // 5. Assertions
    expect(result.success).toBe(true);
    expect(result.txHash).toBe("0xmocktxhash");

    expect(prisma.rebalancePlan.updateMany).toHaveBeenCalledWith({
      where: { id: "test-plan-id", status: "approved" },
      data: {
        status: "executing",
        decisionNote: "Initiating on-chain transaction execution..."
      }
    });

    expect(prisma.rebalancePlan.update).toHaveBeenCalledTimes(1);
    expect(prisma.rebalancePlan.update).toHaveBeenNthCalledWith(1, {
      where: { id: "test-plan-id" },
      data: {
        status: "completed",
        decidedAt: expect.any(Date),
        decisionNote: "Successfully executed on-chain. Tx Hash: 0xmocktxhash"
      }
    });

    expect(mockCall).toHaveBeenCalledWith({
      account: mockWalletClient.account.address,
      to: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
      data: "0x12345678"
    });
    expect(mockSendTransaction).toHaveBeenCalledWith({
      to: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
      data: "0x12345678",
      gas: 150000n,
      chain: mockWalletClient.chain,
      account: mockWalletClient.account
    });
  });

  it("executes with an accepted uncovered debt override", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "approved"
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "validated",
      checks: [{ label: "Uncovered debt", ok: true, detail: "$8.39 accepted by user; normal limit $1.5 after $0 fee credit" }],
      atomicCall: {
        status: "prepared",
        target: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
        data: "0x12345678"
      }
    } as any);
    vi.mocked(chain.createAutopilotExecutorWalletClient).mockReturnValue({
      sendTransaction: vi.fn().mockResolvedValue("0xmocktxhash"),
      chain: { id: 8453 },
      account: { address: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45" }
    } as any);
    vi.mocked(chain.createBaseClient).mockReturnValue({
      call: vi.fn().mockResolvedValue("0x"),
      estimateGas: vi.fn().mockResolvedValue(100000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        gasUsed: 100000n
      })
    } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id", { allowUncoveredDebt: true });

    expect(result.success).toBe(true);
    expect(executor.createAutopilotDryRunExecution).toHaveBeenCalledWith("test-plan-id", { allowUncoveredDebt: true });
    expect(prisma.rebalancePlan.updateMany).toHaveBeenCalledWith({
      where: { id: "test-plan-id", status: "approved" },
      data: {
        status: "executing",
        decisionNote: "Initiating on-chain transaction execution with user-accepted uncovered debt..."
      }
    });
  });

  it("executes with an accepted boundary drift override", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "approved"
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "validated",
      checks: [{ label: "Boundary drift", ok: true, detail: "35.0 bps above upper boundary $1,900.79; limit 30 bps; accepted by user" }],
      atomicCall: {
        status: "prepared",
        target: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
        data: "0x12345678"
      }
    } as any);
    vi.mocked(chain.createAutopilotExecutorWalletClient).mockReturnValue({
      sendTransaction: vi.fn().mockResolvedValue("0xmocktxhash"),
      chain: { id: 8453 },
      account: { address: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45" }
    } as any);
    vi.mocked(chain.createBaseClient).mockReturnValue({
      call: vi.fn().mockResolvedValue("0x"),
      estimateGas: vi.fn().mockResolvedValue(100000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "success",
        gasUsed: 100000n
      })
    } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id", { allowBoundaryDrift: true });

    expect(result.success).toBe(true);
    expect(executor.createAutopilotDryRunExecution).toHaveBeenCalledWith("test-plan-id", { allowBoundaryDrift: true });
    expect(prisma.rebalancePlan.updateMany).toHaveBeenCalledWith({
      where: { id: "test-plan-id", status: "approved" },
      data: {
        status: "executing",
        decisionNote: "Initiating on-chain transaction execution with user-accepted boundary drift..."
      }
    });
  });

  it("reports out-of-gas reverted receipts with gas usage", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "approved"
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "validated",
      checks: [],
      atomicCall: {
        status: "prepared",
        target: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
        data: "0x12345678"
      }
    } as any);

    vi.mocked(chain.createAutopilotExecutorWalletClient).mockReturnValue({
      sendTransaction: vi.fn().mockResolvedValue("0xmocktxhash"),
      chain: { id: 8453 },
      account: { address: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45" }
    } as any);
    vi.mocked(chain.createBaseClient).mockReturnValue({
      call: vi.fn().mockResolvedValue("0x"),
      estimateGas: vi.fn().mockResolvedValue(100000n),
      waitForTransactionReceipt: vi.fn().mockResolvedValue({
        status: "reverted",
        transactionHash: "0xmocktxhash",
        gasUsed: 149000n
      })
    } as any);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("trace unavailable"));

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Out of gas during atomic rebalance");
    expect(result.error).toContain("Gas used 149000 / limit 150000");
    fetchSpy.mockRestore();
  });

  it("fails before broadcasting when dry-run validation fails", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "executing"
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);

    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "blocked",
      checks: [{ label: "check1", ok: false, detail: "failed check detail" }],
      atomicCall: { status: "blocked", reason: "error" }
    } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Dry-run validation blocked: check1: failed check detail");
    expect(prisma.rebalancePlan.updateMany).toHaveBeenCalledWith({
      where: { id: "test-plan-id", status: "approved" },
      data: {
        status: "executing",
        decisionNote: "Initiating on-chain transaction execution..."
      }
    });
    expect(prisma.rebalancePlan.update).toHaveBeenCalledWith({
      where: { id: "test-plan-id" },
      data: {
        status: "failed",
        decidedAt: expect.any(Date),
        decisionNote: "On-chain execution failed: Dry-run validation blocked: check1: failed check detail"
      }
    });
  });

  it("does not touch the plan while live execution is disabled", async () => {
    liveExecutionEnabled = false;

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Live execution is disabled");
    expect(prisma.rebalancePlan.findUnique).not.toHaveBeenCalled();
    expect(prisma.rebalancePlan.update).not.toHaveBeenCalled();
    expect(prisma.rebalancePlan.updateMany).not.toHaveBeenCalled();
  });

  it("does not build a dry-run or broadcast when the plan is already executing", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "executing"
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 0 } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Plan status is executing");
    expect(executor.createAutopilotDryRunExecution).not.toHaveBeenCalled();
    expect(chain.createAutopilotExecutorWalletClient).not.toHaveBeenCalled();
    expect(prisma.rebalancePlan.update).not.toHaveBeenCalled();
  });

  it("returns a concise preflight simulation error instead of a raw viem dump", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "approved"
    } as any);
    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "validated",
      checks: [],
      atomicCall: {
        status: "prepared",
        target: "0xb6Ba43FDCC4a501f4F7Eb5e3BB9F9385103eaDb0",
        data: "0x12345678"
      }
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);
    vi.mocked(chain.createAutopilotExecutorWalletClient).mockReturnValue({
      chain: { id: 8453 },
      account: { address: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45" }
    } as any);
    vi.mocked(chain.createBaseClient).mockReturnValue({
      call: vi.fn().mockRejectedValue(
        new Error(
          [
            "Execution reverted for an unknown reason.",
            "",
            "Raw Call Arguments:",
            "  from: 0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45",
            `  data: 0x${"ab".repeat(5_000)}`,
            "",
            "Details: execution reverted"
          ].join("\n")
        )
      )
    } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toBe("Execution reverted: for an unknown reason");
    expect(result.error?.length).toBeLessThan(200);
    expect(prisma.rebalancePlan.update).toHaveBeenCalledWith({
      where: { id: "test-plan-id" },
      data: {
        status: "failed",
        decidedAt: expect.any(Date),
        decisionNote: "On-chain execution failed: Execution reverted: for an unknown reason"
      }
    });
  });
});
