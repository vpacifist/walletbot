/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionStatus } from "@/generated/prisma/client";
import { buildTopUpPlan } from "@/lib/autopilot-top-up";
import { autopilotPlanKey, getCurrentAutopilotPlan } from "@/lib/autopilot-service";
import { createBaseClient } from "@/lib/chain";
import { CONTRACTS } from "@/lib/constants";
import { prisma } from "@/lib/db";

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      AUTOPILOT_TOP_UP_ENABLED: true,
      AUTOPILOT_TOP_UP_MIN_USD: 10,
      AUTOPILOT_TOP_UP_COOLDOWN_HOURS: 24,
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
    createBaseClient: vi.fn()
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
        findMany: vi.fn()
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
