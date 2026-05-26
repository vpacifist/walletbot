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
    createBaseClient: vi.fn(),
    createBaseWalletClient: vi.fn()
  };
});

let liveExecutionEnabled = true;

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      AUTOPILOT_LIVE_EXECUTION_ENABLED: liveExecutionEnabled
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
    vi.mocked(chain.createBaseWalletClient).mockReturnValue(mockWalletClient as any);

    const mockWaitForTransactionReceipt = vi.fn().mockResolvedValue({
      status: "success",
      transactionHash: "0xmocktxhash"
    });
    const mockCall = vi.fn().mockResolvedValue("0x");
    const mockPublicClient = {
      call: mockCall,
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
      chain: mockWalletClient.chain,
      account: mockWalletClient.account
    });
  });

  it("fails before broadcasting when dry-run validation fails", async () => {
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "test-plan-id",
      status: "approved"
    } as any);

    vi.mocked(executor.createAutopilotDryRunExecution).mockResolvedValue({
      planId: "test-plan-id",
      status: "blocked",
      checks: [{ label: "check1", ok: false, detail: "failed check detail" }],
      atomicCall: { status: "blocked", reason: "error" }
    } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("Dry-run validation blocked: check1: failed check detail");
    expect(prisma.rebalancePlan.updateMany).not.toHaveBeenCalled();
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

  it("does not broadcast when the plan was already changed before submission", async () => {
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
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 0 } as any);

    const result = await broadcastAutopilotRebalance("test-plan-id");

    expect(result.success).toBe(false);
    expect(result.error).toContain("already executed or changed");
    expect(chain.createBaseWalletClient).not.toHaveBeenCalled();
    expect(prisma.rebalancePlan.update).not.toHaveBeenCalled();
  });
});
