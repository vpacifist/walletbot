/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionStatus } from "@/generated/prisma/client";
import { isOutOfRange, sendAutopilotPlanAlert, sendOutOfRangeAlerts } from "@/lib/alerts";
import { getOrCreatePendingAutopilotPlan } from "@/lib/autopilot-service";
import { prisma } from "@/lib/db";

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      TELEGRAM_CHAT_ID: "63853863"
    }))
  };
});

vi.mock("@/lib/autopilot-service", () => {
  return {
    getOrCreatePendingAutopilotPlan: vi.fn()
  };
});

vi.mock("@/lib/db", () => {
  return {
    prisma: {
      telegramEvent: {
        findUnique: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn()
      },
      rebalancePlan: {
        update: vi.fn()
      },
      position: {
        findMany: vi.fn(),
        update: vi.fn(),
        updateMany: vi.fn()
      }
    }
  };
});

function planRecord(input: any = {}) {
  return {
    plan: {
      state: "confirming",
      title: "Small-capital plan",
      telegramSummary: "Small-capital plan\nState: confirming",
      strategy: { preset: "small_capital_test" },
      pool: { currentTick: -200120 },
      ladder: [
        {
          role: "active",
          tokenId: "5199548",
          lowerTick: -200100,
          upperTick: -199860
        }
      ],
      actions: [{ type: "close", label: "Close current test range", tokenId: "5199548" }],
      ...input.plan
    },
    record: {
      id: "plan-1",
      planKey: "plan-key-1",
      telegramChatId: "63853863",
      telegramMessageId: null,
      ...input.record
    }
  };
}

function bot() {
  return {
    telegram: {
      sendMessage: vi.fn().mockResolvedValue({ chat: { id: 63853863 }, message_id: 42 })
    }
  };
}

describe("sendAutopilotPlanAlert", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.telegramEvent.findUnique).mockResolvedValue(null);
  });

  it("sends a new executable autopilot plan without waiting for /autopilot", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(planRecord() as any);
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 1, planId: "plan-1" });
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      "Small-capital plan\nState: confirming\n\nPlan id: plan-1",
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array)
        })
      })
    );
    expect(prisma.rebalancePlan.update).toHaveBeenCalledWith({
      where: { id: "plan-1" },
      data: {
        telegramChatId: "63853863",
        telegramMessageId: "42"
      }
    });
    expect(prisma.telegramEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        alertType: "autopilot_plan",
        dedupeKey: "autopilot-incident:small_capital_test:5199548:-200100:-199860:below_range"
      })
    });
  });

  it("does not send idle plans", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          state: "idle",
          actions: [{ type: "hold", label: "Hold single test range" }]
        }
      }) as any
    );
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 0, skipped: "plan_does_not_need_attention" });
    expect(prisma.telegramEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        alertType: "autopilot_plan",
        dedupeKey: { startsWith: "autopilot-incident:" }
      }
    });
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does not resend the same small-capital breakout when tick and cost change", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        record: {
          id: "plan-2",
          planKey: "different-price-sensitive-plan-key"
        },
        plan: {
          pool: { currentTick: -200180 },
          economics: { immediateCostUsd: 1.23 }
        }
      }) as any
    );
    vi.mocked(prisma.telegramEvent.findUnique).mockResolvedValue({ id: "event-1" } as any);
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 0, skipped: "duplicate_plan_key" });
    expect(prisma.telegramEvent.findUnique).toHaveBeenCalledWith({
      where: {
        dedupeKey: "autopilot-incident:small_capital_test:5199548:-200100:-199860:below_range"
      }
    });
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });

  it("does not duplicate a plan that already has a Telegram message", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        record: {
          telegramMessageId: "41"
        }
      }) as any
    );
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 0, skipped: "plan_already_has_telegram_message" });
    expect(prisma.telegramEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        alertType: "autopilot_plan",
        dedupeKey: "autopilot-incident:small_capital_test:5199548:-200100:-199860:below_range"
      })
    });
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
  });
});

describe("sendOutOfRangeAlerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.telegramEvent.findUnique).mockResolvedValue(null);
    vi.mocked(prisma.position.update).mockResolvedValue({} as any);
    vi.mocked(prisma.position.updateMany).mockResolvedValue({ count: 0 } as any);
  });

  it("does not send a duplicate range alert when the autopilot plan message was already sent", async () => {
    vi.mocked(prisma.position.findMany).mockResolvedValue([
      {
        id: "position-row-1",
        tokenId: "5199548",
        status: PositionStatus.below_range,
        lastAlertStatus: PositionStatus.in_range,
        currentTick: -200120,
        tickLower: -200100,
        tickUpper: -199860,
        poolAddress: "0x6c56d16237190256f56b6b148e0d8a6017c1372",
        wallet: { address: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057" }
      }
    ] as any);
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        record: {
          telegramMessageId: "42"
        }
      }) as any
    );
    const testBot = bot();

    const result = await sendOutOfRangeAlerts(testBot as any);

    expect(result).toEqual({ sent: 0, skippedAutopilotPlanMessage: 1 });
    expect(testBot.telegram.sendMessage).not.toHaveBeenCalled();
    expect(prisma.telegramEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        positionId: "position-row-1",
        alertType: "out_of_range",
        dedupeKey: "out-of-range:position-row-1:below_range:-200120",
        payload: expect.objectContaining({
          skippedBecause: "autopilot_plan_message_exists",
          planId: "plan-1"
        })
      })
    });
    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: "position-row-1" },
      data: { lastAlertStatus: PositionStatus.below_range }
    });
  });
});

describe("isOutOfRange", () => {
  it("only treats above and below range as alertable", () => {
    expect(isOutOfRange(PositionStatus.above_range)).toBe(true);
    expect(isOutOfRange(PositionStatus.below_range)).toBe(true);
    expect(isOutOfRange(PositionStatus.in_range)).toBe(false);
    expect(isOutOfRange(PositionStatus.closed_or_zero_liquidity)).toBe(false);
    expect(isOutOfRange(PositionStatus.unknown)).toBe(false);
  });
});
