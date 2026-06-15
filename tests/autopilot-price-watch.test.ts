/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionStatus } from "@/generated/prisma/client";
import { checkAutopilotPriceBoundary, resetAutopilotPriceWatchStateForTest } from "@/lib/autopilot-price-watch";
import { sendTopUpOpportunityAlert } from "@/lib/autopilot-top-up";
import { sendAutopilotPlanAlert } from "@/lib/alerts";
import { createBaseClient } from "@/lib/chain";
import { prisma } from "@/lib/db";
import { refreshTrackedPositionsForWallet } from "@/lib/positions";

let autopilotMode = "auto_guarded";

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      AUTOPILOT_MODE: autopilotMode,
      AUTOPILOT_PRICE_WATCH_INTERVAL_MS: 1000,
      AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS: 5,
      AUTOPILOT_TOP_UP_ENABLED: true,
      AUTOPILOT_TOP_UP_WATCH_INTERVAL_MS: 30000,
      AUTOPILOT_TOP_UP_MIN_EFFICIENCY_BPS: 8500,
      AUTOPILOT_TOP_UP_MIN_BOUNDARY_DISTANCE_TICKS: 10,
      BASE_WALLET_ADDRESS: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057",
      TELEGRAM_CHAT_ID: "63853863"
    }))
  };
});

vi.mock("@/lib/chain", () => {
  return {
    baseRpcUrlsWithPublicFallback: vi.fn(() => []),
    createBaseClientForUrl: vi.fn(),
    createBaseClient: vi.fn()
  };
});

vi.mock("@/lib/alerts", () => {
  return {
    sendAutopilotPlanAlert: vi.fn()
  };
});

vi.mock("@/lib/autopilot-top-up", () => {
  return {
    sendTopUpOpportunityAlert: vi.fn()
  };
});

vi.mock("@/lib/positions", () => {
  return {
    refreshTrackedPositionsForWallet: vi.fn()
  };
});

vi.mock("@/lib/db", () => {
  return {
    prisma: {
      wallet: {
        findUnique: vi.fn()
      },
      telegramEvent: {
        findFirst: vi.fn()
      },
      position: {
        findFirst: vi.fn(),
        update: vi.fn()
      }
    }
  };
});

function bot() {
  return {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({})
    }
  };
}

function mockPoolTick(tick: number) {
  vi.mocked(createBaseClient).mockReturnValue({
    readContract: vi.fn().mockImplementation((params) => {
      if (params.functionName === "slot0") return Promise.resolve([0n, tick]);
      if (params.functionName === "positions") return Promise.resolve([0n, "0x0", "0x0", "0x0", 3000, -201600, -201360, 1n]);
      return Promise.reject(new Error(`Unexpected readContract ${params.functionName}`));
    })
  } as any);
}

function mockPoolTickWithClosedPosition(tick: number) {
  vi.mocked(createBaseClient).mockReturnValue({
    readContract: vi.fn().mockImplementation((params) => {
      if (params.functionName === "slot0") return Promise.resolve([0n, tick]);
      if (params.functionName === "positions") return Promise.resolve([0n, "0x0", "0x0", "0x0", 3000, -201600, -201360, 0n]);
      return Promise.reject(new Error(`Unexpected readContract ${params.functionName}`));
    })
  } as any);
}

function mockActiveRange() {
  vi.mocked(prisma.wallet.findUnique).mockResolvedValue({ id: "wallet-1" } as any);
  vi.mocked(prisma.position.findFirst).mockResolvedValue({
    id: "position-1",
    tokenId: "5257034",
    fee: 3000,
    status: PositionStatus.in_range,
    tickLower: -201600,
    tickUpper: -201360
  } as any);
}

describe("checkAutopilotPriceBoundary", () => {
  beforeEach(() => {
    autopilotMode = "auto_guarded";
    vi.clearAllMocks();
    resetAutopilotPriceWatchStateForTest();
    mockActiveRange();
    vi.mocked(prisma.telegramEvent.findFirst).mockResolvedValue(null);
    vi.mocked(sendAutopilotPlanAlert).mockResolvedValue({ sent: 1, planId: "plan-1" } as any);
    vi.mocked(sendTopUpOpportunityAlert).mockResolvedValue({ sent: 0, skipped: "below_minimum_value" } as any);
    vi.mocked(refreshTrackedPositionsForWallet).mockResolvedValue([]);
  });

  it("does nothing while the live tick is inside the active range", async () => {
    mockPoolTick(-201500);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: false, skipped: "inside_range", tick: -201500 });
    expect(sendTopUpOpportunityAlert).toHaveBeenCalledWith(testBot, -201500);
    expect(sendAutopilotPlanAlert).not.toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("throttles top-up opportunity checks while the tick remains inside range", async () => {
    mockPoolTick(-201500);
    const testBot = bot();

    await checkAutopilotPriceBoundary(testBot as any);
    await checkAutopilotPriceBoundary(testBot as any);

    expect(sendTopUpOpportunityAlert).toHaveBeenCalledTimes(1);
  });

  it("ignores a one-tick micro-breakout", async () => {
    mockPoolTick(-201601);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: false, skipped: "micro_breakout", tick: -201601, tokenId: "5257034", side: "below", depthTicks: 1 });
    expect(sendAutopilotPlanAlert).not.toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("triggers the existing auto alert path without sending a standalone fast-trigger message", async () => {
    mockPoolTick(-201605);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: true, tick: -201605, tokenId: "5257034", side: "below", depthTicks: 5 });
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
    expect(sendAutopilotPlanAlert).toHaveBeenCalledWith(testBot);
  });

  it("refreshes positions and skips stale closed ranges before triggering", async () => {
    mockPoolTickWithClosedPosition(-201605);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: false, skipped: "stale_closed_position", tick: -201605, tokenId: "5257034" });
    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: "position-1" },
      data: expect.objectContaining({
        liquidity: "0",
        status: PositionStatus.closed_or_zero_liquidity
      })
    });
    expect(refreshTrackedPositionsForWallet).toHaveBeenCalledWith(["5257034"]);
    expect(sendAutopilotPlanAlert).not.toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does not repeatedly trigger the same out-of-range incident", async () => {
    mockPoolTick(-201605);
    const testBot = bot();

    await checkAutopilotPriceBoundary(testBot as any);
    const second = await checkAutopilotPriceBoundary(testBot as any);

    expect(second).toMatchObject({ triggered: false, skipped: "duplicate_fast_trigger" });
    expect(sendAutopilotPlanAlert).toHaveBeenCalledTimes(1);
  });

  it("re-enters the auto alert path after a sustained breakout wait expires", async () => {
    mockPoolTick(-201605);
    vi.mocked(prisma.telegramEvent.findFirst).mockResolvedValue({
      sentAt: new Date(Date.now() - 16 * 60 * 1000)
    } as any);
    const testBot = bot();

    await checkAutopilotPriceBoundary(testBot as any);
    const second = await checkAutopilotPriceBoundary(testBot as any);

    expect(second).toMatchObject({ triggered: true, tick: -201605, tokenId: "5257034", side: "below", depthTicks: 5 });
    expect(sendAutopilotPlanAlert).toHaveBeenCalledTimes(2);
  });

  it("offers an explicit retry button when the current incident was already deduped", async () => {
    mockPoolTick(-201605);
    vi.mocked(sendAutopilotPlanAlert).mockResolvedValue({ sent: 0, skipped: "duplicate_plan_key" } as any);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: true, result: { skipped: "duplicate_plan_key" } });
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Auto-guarded retry is waiting for your confirmation"),
      {
        reply_markup: {
          inline_keyboard: [[{ text: "Retry current incident", callback_data: "ap:retry_current" }]]
        }
      }
    );
  });

  it("allows retry flow after auto_guarded fails before the incident leaves range", async () => {
    mockPoolTick(-201605);
    vi.mocked(sendAutopilotPlanAlert)
      .mockResolvedValueOnce({ sent: 1, planId: "plan-1", autoGuarded: "failed" } as any)
      .mockResolvedValueOnce({ sent: 0, skipped: "duplicate_plan_key" } as any);
    const testBot = bot();

    const first = await checkAutopilotPriceBoundary(testBot as any);
    const second = await checkAutopilotPriceBoundary(testBot as any);

    expect(first).toMatchObject({ triggered: true, result: { autoGuarded: "failed" } });
    expect(second).toMatchObject({ triggered: true, result: { skipped: "duplicate_plan_key" } });
    expect(sendAutopilotPlanAlert).toHaveBeenCalledTimes(2);
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Auto-guarded retry is waiting for your confirmation"),
      expect.any(Object)
    );
  });

  it("is disabled outside auto_guarded mode", async () => {
    autopilotMode = "approve_in_telegram";
    mockPoolTick(-201605);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toEqual({ triggered: false, skipped: "mode_not_auto_guarded" });
    expect(createBaseClient).not.toHaveBeenCalled();
    expect(sendAutopilotPlanAlert).not.toHaveBeenCalled();
  });
});
