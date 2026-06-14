/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionStatus } from "@/generated/prisma/client";
import { buildTopUpPlan, sendTopUpOpportunityAlert } from "@/lib/autopilot-top-up";
import { autopilotPlanKey, getCurrentAutopilotPlan } from "@/lib/autopilot-service";
import { createBaseClient, createBaseWalletClient } from "@/lib/chain";
import { CONTRACTS } from "@/lib/constants";
import { prisma } from "@/lib/db";

let topUpAutoEnabled = false;

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      AUTOPILOT_TOP_UP_ENABLED: true,
      AUTOPILOT_TOP_UP_MIN_USD: 10,
      AUTOPILOT_TOP_UP_COOLDOWN_HOURS: 24,
      AUTOPILOT_TOP_UP_MIN_EFFICIENCY_BPS: 8500,
      AUTOPILOT_TOP_UP_MIN_BOUNDARY_DISTANCE_TICKS: 10,
      AUTOPILOT_TOP_UP_AUTO_ENABLED: topUpAutoEnabled,
      AUTOPILOT_TOP_UP_AUTO_MIN_USD: 25,
      AUTOPILOT_TOP_UP_AUTO_MIN_EFFICIENCY_BPS: 8500,
      AUTOPILOT_TOP_UP_AUTO_MIN_BOUNDARY_DISTANCE_TICKS: 30,
      AUTOPILOT_TOP_UP_AUTO_MAX_GAS_COST_USD: 0.2,
      AUTOPILOT_LIVE_EXECUTION_ENABLED: true,
      BLOCKSCOUT_BASE_URL: "https://base.blockscout.com",
      TELEGRAM_CHAT_ID: "63853863",
      BASE_WALLET_ADDRESS: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057",
      BASE_WALLET_PRIVATE_KEY: "0x1111111111111111111111111111111111111111111111111111111111111111"
    }))
  };
});

vi.mock("@/lib/autopilot-service", () => {
  return {
    getCurrentAutopilotPlan: vi.fn(),
    autopilotPlanKey: vi.fn()
  };
});

vi.mock("@/lib/chain", () => {
  return {
    createBaseClient: vi.fn(),
    createBaseWalletClient: vi.fn()
  };
});

vi.mock("@/lib/db", () => {
  return {
    prisma: {
      wallet: {
        findUnique: vi.fn()
      },
      position: {
        findFirst: vi.fn()
      },
      rebalancePlan: {
        findFirst: vi.fn(),
        findMany: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn()
      },
      telegramEvent: {
        findUnique: vi.fn(),
        create: vi.fn()
      }
    }
  };
});

const walletWethRaw = 242_375_391_314_575_060n;
const walletUsdcRaw = 346_425_553n;

function activePosition() {
  return {
    id: "position-1",
    walletId: "wallet-1",
    tokenId: "5277838",
    poolAddress: "0x6c561B446416E1A00E8E93E221854d6eA4171372",
    token0: CONTRACTS.weth,
    token1: CONTRACTS.usdc,
    fee: 3000,
    tickLower: -202740,
    tickUpper: -202500,
    currentTick: -202621,
    liquidity: "315091687082156",
    wethAmount: "0.043830587498862013",
    usdcAmount: "68.435636",
    status: PositionStatus.in_range
  };
}

function currentAutopilotPlan(input: { state?: string; actionType?: string } = {}) {
  return {
    state: input.state ?? "idle",
    actions: [{ type: input.actionType ?? "hold", label: "Hold single test range" }]
  };
}

function mockReadyTopUpInputs() {
  vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: "wallet-1" } as any);
  vi.mocked(prisma.position.findFirst).mockResolvedValue(activePosition() as any);
  (prisma.rebalancePlan.findFirst as any).mockImplementation(async (args: any) => {
    if (args.where?.status === "executing") return null;
    if (args.where?.mode === "top_up") return null;
    return null;
  });
  vi.mocked(prisma.rebalancePlan.findMany).mockResolvedValue([]);
  vi.mocked(getCurrentAutopilotPlan).mockResolvedValue(currentAutopilotPlan() as any);
  vi.mocked(autopilotPlanKey).mockReturnValue("current-plan-key");
  vi.mocked(createBaseClient).mockReturnValue({
    readContract: vi.fn().mockImplementation((params) => {
      if (params.functionName === "balanceOf" && params.address === CONTRACTS.weth) return Promise.resolve(walletWethRaw);
      if (params.functionName === "balanceOf" && params.address === CONTRACTS.usdc) return Promise.resolve(walletUsdcRaw);
      return Promise.reject(new Error(`Unexpected readContract ${params.functionName}`));
    })
  } as any);
}

describe("buildTopUpPlan autopilot execution guard", () => {
  beforeEach(() => {
    topUpAutoEnabled = false;
    vi.clearAllMocks();
    mockReadyTopUpInputs();
  });

  it("keeps blocking while an autopilot plan is executing", async () => {
    (prisma.rebalancePlan.findFirst as any).mockImplementation(async (args: any) => {
      if (args.where?.status === "executing") return { id: "executing-plan", status: "executing" } as any;
      return null;
    });

    const result = await buildTopUpPlan();

    expect(result).toEqual({ status: "skipped", reason: "autopilot_execution_active" });
    expect(getCurrentAutopilotPlan).not.toHaveBeenCalled();
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  });

  it("blocks an approved plan only when it is still the current actionable autopilot plan", async () => {
    vi.mocked(prisma.rebalancePlan.findMany).mockResolvedValue([{ id: "approved-plan", planKey: "current-plan-key" }] as any);
    vi.mocked(getCurrentAutopilotPlan).mockResolvedValue(currentAutopilotPlan({ state: "confirming", actionType: "close" }) as any);

    const result = await buildTopUpPlan();

    expect(result).toEqual({ status: "skipped", reason: "autopilot_execution_active" });
    expect(autopilotPlanKey).toHaveBeenCalled();
    expect(prisma.wallet.findUnique).not.toHaveBeenCalled();
  });

  it("ignores stale approved autopilot plans when the current autopilot state is idle", async () => {
    vi.mocked(prisma.rebalancePlan.findMany).mockResolvedValue([{ id: "stale-approved-plan", planKey: "old-plan-key" }] as any);
    vi.mocked(getCurrentAutopilotPlan).mockResolvedValue(currentAutopilotPlan({ state: "idle", actionType: "hold" }) as any);

    const result = await buildTopUpPlan();

    expect(result.status).toBe("ready");
    if (result.status === "ready") {
      expect(result.payload.tokenId).toBe("5277838");
      expect(result.payload.efficiencyBps).toBeGreaterThanOrEqual(8500);
      expect(result.payload.boundaryDistanceTicks).toBe(119);
    }
  });
});

function bot() {
  return {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({ chat: { id: 63853863 }, message_id: 42 })
    }
  };
}

function mockTopUpExecutionInputs() {
  const readContract = vi.fn().mockImplementation((params) => {
    if (params.functionName === "balanceOf" && params.address === CONTRACTS.weth) return Promise.resolve(walletWethRaw);
    if (params.functionName === "balanceOf" && params.address === CONTRACTS.usdc) return Promise.resolve(walletUsdcRaw);
    if (params.functionName === "getPool") return Promise.resolve("0x6c561B446416E1A00E8E93E221854d6eA4171372");
    if (params.functionName === "slot0") return Promise.resolve([0n, -202621]);
    if (params.functionName === "allowance") return Promise.resolve(2n ** 255n);
    return Promise.reject(new Error(`Unexpected readContract ${params.functionName}`));
  });
  const waitForTransactionReceipt = vi.fn().mockResolvedValue({ status: "success" });
  vi.mocked(createBaseClient).mockReturnValue({
    readContract,
    call: vi.fn().mockResolvedValue("0x"),
    estimateGas: vi.fn().mockResolvedValue(220_000n),
    getGasPrice: vi.fn().mockResolvedValue(6_000_000n),
    waitForTransactionReceipt
  } as any);
  const sendTransaction = vi.fn().mockResolvedValue("0xtopuphash");
  vi.mocked(createBaseWalletClient).mockReturnValue({
    account: { address: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057" },
    chain: { id: 8453 },
    sendTransaction
  } as any);
  return { sendTransaction };
}

describe("sendTopUpOpportunityAlert auto guarded mode", () => {
  beforeEach(() => {
    topUpAutoEnabled = true;
    vi.clearAllMocks();
    mockReadyTopUpInputs();
    vi.mocked(prisma.telegramEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.telegramEvent.create).mockResolvedValue({ id: "event-1" } as any);
    vi.mocked(prisma.rebalancePlan.create).mockResolvedValue({
      id: "top-up-plan-1",
      planKey: "top-up-key",
      status: "pending",
      mode: "top_up",
      state: "ready",
      title: "Top up current range",
      summary: "summary",
      payload: {},
      telegramChatId: "63853863",
      telegramMessageId: null,
      decidedAt: null,
      decisionNote: null,
      createdAt: new Date(),
      updatedAt: new Date()
    } as any);
    (prisma.rebalancePlan.update as any).mockImplementation(async (args: any) => ({
      id: args.where.id,
      status: args.data.status ?? "approved",
      payload: args.data.payload ?? {},
      ...args.data
    }) as any);
    vi.mocked(prisma.rebalancePlan.findUnique).mockResolvedValue({
      id: "top-up-plan-1",
      status: "approved",
      mode: "top_up",
      payload: {
        kind: "top_up",
        tokenId: "5277838",
        tickLower: -202740,
        tickUpper: -202500,
        currentTick: -202621,
        priceUsd: 1600,
        token0: CONTRACTS.weth,
        token1: CONTRACTS.usdc,
        walletWethRaw: walletWethRaw.toString(),
        walletUsdcRaw: walletUsdcRaw.toString(),
        amount0DesiredRaw: "10568118206125668",
        amount1DesiredRaw: "108753432",
        amount0MinRaw: "0",
        amount1MinRaw: "0",
        wethDesired: 0.010568,
        usdcDesired: 108.75,
        valueUsd: 125.66,
        walletValueUsd: 734.23,
        efficiencyBps: 9000,
        boundaryDistanceTicks: 119,
        leftoverWeth: 0.23,
        leftoverUsdc: 237.67
      }
    } as any);
    vi.mocked(prisma.rebalancePlan.updateMany).mockResolvedValue({ count: 1 } as any);
    mockTopUpExecutionInputs();
  });

  it("auto-approves and broadcasts a guarded top-up when strict guardrails pass", async () => {
    const testBot = bot();

    const result = await sendTopUpOpportunityAlert(testBot as any, -202621);

    expect(result).toMatchObject({ sent: 1, planId: "top-up-plan-1", autoTopUp: "sent", txHash: "0xtopuphash" });
    expect(prisma.rebalancePlan.update).toHaveBeenCalledWith({
      where: { id: "top-up-plan-1" },
      data: expect.objectContaining({
        status: "approved",
        decisionNote: "Top-up approved in Telegram."
      })
    });
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith("63853863", expect.stringContaining("Auto top-up is being sent"));
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith("63853863", expect.stringContaining("Auto top-up sent"));
    expect(prisma.telegramEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        alertType: "top_up_opportunity",
        payload: expect.objectContaining({ auto: true, success: true })
      })
    });
  });
});
