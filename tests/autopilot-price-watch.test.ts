/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionStatus } from "@/generated/prisma/client";
import { checkAutopilotPriceBoundary, resetAutopilotPriceWatchStateForTest } from "@/lib/autopilot-price-watch";
import { sendAutopilotPlanAlert } from "@/lib/alerts";
import { createBaseClient } from "@/lib/chain";
import { prisma } from "@/lib/db";

let autopilotMode = "auto_guarded";

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      AUTOPILOT_MODE: autopilotMode,
      AUTOPILOT_PRICE_WATCH_INTERVAL_MS: 1000,
      BASE_WALLET_ADDRESS: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057",
      TELEGRAM_CHAT_ID: "63853863"
    }))
  };
});

vi.mock("@/lib/chain", () => {
  return {
    createBaseClient: vi.fn()
  };
});

vi.mock("@/lib/alerts", () => {
  return {
    sendAutopilotPlanAlert: vi.fn()
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
    readContract: vi.fn().mockResolvedValue([0n, tick])
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
    vi.mocked(sendAutopilotPlanAlert).mockResolvedValue({ sent: 1, planId: "plan-1" } as any);
  });

  it("does nothing while the live tick is inside the active range", async () => {
    mockPoolTick(-201500);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: false, skipped: "inside_range", tick: -201500 });
    expect(sendAutopilotPlanAlert).not.toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("triggers the existing auto alert path immediately when the live tick crosses below range", async () => {
    mockPoolTick(-201601);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toMatchObject({ triggered: true, tick: -201601, tokenId: "5257034", side: "below" });
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      "Fast price trigger: below boundary crossed\nPosition #5257034\nTick -201601 | Range -201600 - -201360"
    );
    expect(sendAutopilotPlanAlert).toHaveBeenCalledWith(testBot);
  });

  it("does not repeatedly trigger the same out-of-range incident", async () => {
    mockPoolTick(-201601);
    const testBot = bot();

    await checkAutopilotPriceBoundary(testBot as any);
    const second = await checkAutopilotPriceBoundary(testBot as any);

    expect(second).toMatchObject({ triggered: false, skipped: "duplicate_fast_trigger" });
    expect(sendAutopilotPlanAlert).toHaveBeenCalledTimes(1);
  });

  it("offers an explicit retry button when the current incident was already deduped", async () => {
    mockPoolTick(-201601);
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

  it("is disabled outside auto_guarded mode", async () => {
    autopilotMode = "approve_in_telegram";
    mockPoolTick(-201601);
    const testBot = bot();

    const result = await checkAutopilotPriceBoundary(testBot as any);

    expect(result).toEqual({ triggered: false, skipped: "mode_not_auto_guarded" });
    expect(createBaseClient).not.toHaveBeenCalled();
    expect(sendAutopilotPlanAlert).not.toHaveBeenCalled();
  });
});
