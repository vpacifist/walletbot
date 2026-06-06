/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PositionStatus } from "@/generated/prisma/client";
import { isOutOfRange, retryCurrentAutopilotIncident, sendAutopilotPlanAlert, sendOutOfRangeAlerts } from "@/lib/alerts";
import { broadcastAutopilotRebalance } from "@/lib/autopilot-broadcaster";
import { createAutopilotDryRunExecution } from "@/lib/autopilot-executor";
import { isAutopilotRuntimePaused } from "@/lib/autopilot-pause";
import { getOrCreatePendingAutopilotPlan } from "@/lib/autopilot-service";
import { recordAutopilotPlanDecision } from "@/lib/autopilot-service";
import { prisma } from "@/lib/db";
import { syncWalletOnce } from "@/lib/sync";

vi.mock("@/lib/config", () => {
  return {
    getConfig: vi.fn(() => ({
      TELEGRAM_CHAT_ID: "63853863",
      BLOCKSCOUT_BASE_URL: "https://base.blockscout.com",
      AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS: 5,
      AUTOPILOT_AUTO_RETRY_DEDUPE_MS: 300000
    }))
  };
});

vi.mock("@/lib/autopilot-service", () => {
  return {
    getOrCreatePendingAutopilotPlan: vi.fn(),
    recordAutopilotPlanDecision: vi.fn()
  };
});

vi.mock("@/lib/autopilot-executor", () => {
  return {
    createAutopilotDryRunExecution: vi.fn()
  };
});

vi.mock("@/lib/autopilot-broadcaster", () => {
  return {
    broadcastAutopilotRebalance: vi.fn()
  };
});

vi.mock("@/lib/autopilot-pause", () => {
  return {
    isAutopilotRuntimePaused: vi.fn()
  };
});

vi.mock("@/lib/db", () => {
  return {
    prisma: {
      telegramEvent: {
        findUnique: vi.fn(),
        create: vi.fn(),
        deleteMany: vi.fn(),
        upsert: vi.fn()
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

vi.mock("@/lib/sync", () => {
  return {
    syncWalletOnce: vi.fn()
  };
});

function planRecord(input: any = {}) {
  return {
    plan: {
      state: "confirming",
      mode: "approve_in_telegram",
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
    vi.mocked(isAutopilotRuntimePaused).mockResolvedValue(false);
    vi.mocked(recordAutopilotPlanDecision).mockImplementation(async (id) => ({ ...planRecord().record, id, status: "approved" }) as any);
    vi.mocked(syncWalletOnce).mockResolvedValue({ transactionsSeen: 1, positionsSeen: 1, toBlock: 1n } as any);
    vi.mocked(createAutopilotDryRunExecution).mockResolvedValue({
      status: "validated",
      operations: [{ label: "Close/review stale range", detail: "Close current test range" }],
      checks: [],
      telegramSummary: "Executor dry run\nStatus: validated"
    } as any);
    vi.mocked(broadcastAutopilotRebalance).mockResolvedValue({ success: true, txHash: "0xabc" });
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

  it("retries a stale auto_guarded incident instead of keeping the old dedupe forever", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          mode: "auto_guarded"
        }
      }) as any
    );
    vi.mocked(prisma.telegramEvent.findUnique).mockResolvedValue({
      id: "event-1",
      sentAt: new Date(Date.now() - 301_000)
    } as any);
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(prisma.telegramEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        alertType: "autopilot_plan",
        dedupeKey: "autopilot-incident:small_capital_test:5199548:-200100:-199860:below_range"
      }
    });
    expect(result).toEqual({ sent: 1, planId: "plan-1", autoGuarded: "sent", txHash: "0xabc" });
    expect(broadcastAutopilotRebalance).toHaveBeenCalled();
  });

  it("skips auto_guarded micro-breakouts in the regular sync-loop path", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          mode: "auto_guarded",
          pool: { currentTick: -202080 },
          ladder: [
            {
              role: "active",
              tokenId: "5265592",
              lowerTick: -202320,
              upperTick: -202080
            }
          ],
          actions: [{ type: "close", label: "Close current test range", tokenId: "5265592" }]
        }
      }) as any
    );
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({
      sent: 0,
      skipped: "micro_breakout",
      side: "above",
      depthTicks: 1,
      tokenId: "5265592",
      lowerTick: -202320,
      upperTick: -202080,
      thresholdTicks: 5
    });
    expect(recordAutopilotPlanDecision).not.toHaveBeenCalled();
    expect(broadcastAutopilotRebalance).not.toHaveBeenCalled();
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

  it("auto-executes auto_guarded plans with uncovered debt accepted", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan)
      .mockResolvedValueOnce(
        planRecord({
          plan: {
            mode: "auto_guarded"
          }
        }) as any
      )
      .mockResolvedValueOnce(
        planRecord({
          plan: {
            state: "idle",
            mode: "auto_guarded",
            title: "Small test range active",
            pool: { currentTick: -201081, price: 1851.82 },
            economics: {
              reversalDebtUsd: 1.3,
              feeCreditUsd: 0,
              uncoveredReversalDebtUsd: 1.3,
              lastDirectionalSwap: {
                timestamp: "2026-06-03T15:06:43.000Z",
                side: "sell_weth",
                wethAmount: 0.34,
                usdcAmount: 630.61,
                effectivePrice: 1848.02,
                hash: "0xabc",
                protocol: "Uniswap v3"
              }
            },
            ladder: [
              {
                role: "active",
                tokenId: "5246424",
                range: "-201240 - -201000",
                lowerTick: -201240,
                upperTick: -201000,
                lowerPrice: 1822.61,
                upperPrice: 1866.88,
                status: "ok",
                plannedAction: "Keep current 240-tick test range until breakout"
              }
            ],
            actions: [{ type: "hold", label: "Hold single test range" }]
          }
        }) as any
      );
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 1, planId: "plan-1", autoGuarded: "sent", txHash: "0xabc" });
    expect(recordAutopilotPlanDecision).toHaveBeenCalledWith("plan-1", "approved");
    expect(createAutopilotDryRunExecution).toHaveBeenCalledWith("plan-1", { allowUncoveredDebt: true, allowEquivalentPlanFreshness: true });
    expect(broadcastAutopilotRebalance).toHaveBeenCalledWith("plan-1", { allowUncoveredDebt: true, allowEquivalentPlanFreshness: true });
    expect(syncWalletOnce).toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Auto-guarded rebalance is being sent")
    );
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Auto-guarded rebalance sent")
    );
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Auto-guarded post-check")
    );
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Active range: #5246424 -201240 - -201000")
    );
    expect(prisma.telegramEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        alertType: "autopilot_plan",
        dedupeKey: "autopilot-incident:small_capital_test:5199548:-200100:-199860:below_range"
      })
    });
  });

  it("falls back to manual review when auto_guarded is runtime-paused", async () => {
    vi.mocked(isAutopilotRuntimePaused).mockResolvedValue(true);
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          mode: "auto_guarded"
        }
      }) as any
    );
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 1, planId: "plan-1" });
    expect(recordAutopilotPlanDecision).not.toHaveBeenCalled();
    expect(createAutopilotDryRunExecution).not.toHaveBeenCalled();
    expect(broadcastAutopilotRebalance).not.toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      "Small-capital plan\nState: confirming\n\nPlan id: plan-1",
      expect.objectContaining({
        reply_markup: expect.objectContaining({
          inline_keyboard: expect.any(Array)
        })
      })
    );
  });

  it("blocks auto_guarded execution when boundary drift fails", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          mode: "auto_guarded"
        }
      }) as any
    );
    vi.mocked(createAutopilotDryRunExecution).mockResolvedValue({
      status: "blocked",
      checks: [{ label: "Boundary drift", ok: false, detail: "35 bps above upper boundary; limit 30 bps" }],
      telegramSummary: "Executor dry run\nStatus: blocked\nBLOCKED Boundary drift"
    } as any);
    const testBot = bot();

    const result = await sendAutopilotPlanAlert(testBot as any);

    expect(result).toEqual({ sent: 1, planId: "plan-1", autoGuarded: "blocked" });
    expect(broadcastAutopilotRebalance).not.toHaveBeenCalled();
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith(
      "63853863",
      expect.stringContaining("Auto-guarded blocked"),
      expect.objectContaining({
        reply_markup: {
          inline_keyboard: [
            [{ text: "Accept drift & review live transaction", callback_data: "ap:accept_drift:plan-1" }],
            [{ text: "Wait", callback_data: "ap:pause:plan-1" }]
          ]
        }
      })
    );
  });

  it("retries the current incident by clearing only the current autopilot dedupe key", async () => {
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          mode: "auto_guarded"
        }
      }) as any
    );
    const testBot = bot();

    const result = await retryCurrentAutopilotIncident(testBot as any);

    expect(prisma.telegramEvent.deleteMany).toHaveBeenCalledWith({
      where: {
        alertType: "autopilot_plan",
        dedupeKey: "autopilot-incident:small_capital_test:5199548:-200100:-199860:below_range"
      }
    });
    expect(result).toEqual({ sent: 1, planId: "plan-1", autoGuarded: "sent", txHash: "0xabc" });
    expect(testBot.telegram.sendMessage).toHaveBeenCalledWith("63853863", "Retrying current autopilot incident\nPlan id: plan-1");
    expect(broadcastAutopilotRebalance).toHaveBeenCalled();
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

  it("suppresses the manual out-of-range message when auto_guarded is only a micro-breakout", async () => {
    vi.mocked(prisma.position.findMany).mockResolvedValue([
      {
        id: "position-row-1",
        tokenId: "5276554",
        status: PositionStatus.above_range,
        lastAlertStatus: PositionStatus.in_range,
        currentTick: -202739,
        tickLower: -202980,
        tickUpper: -202740,
        poolAddress: "0x6c56d16237190256f56b6b148e0d8a6017c1372",
        wallet: { address: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057" }
      }
    ] as any);
    vi.mocked(getOrCreatePendingAutopilotPlan).mockResolvedValue(
      planRecord({
        plan: {
          mode: "auto_guarded",
          pool: { currentTick: -202739 },
          ladder: [
            {
              role: "active",
              tokenId: "5276554",
              lowerTick: -202980,
              upperTick: -202740
            }
          ],
          actions: [{ type: "close", label: "Close current test range", tokenId: "5276554" }]
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
        dedupeKey: "out-of-range:position-row-1:above_range:-202739",
        payload: expect.objectContaining({
          skippedBecause: "autopilot_micro_breakout",
          planId: "plan-1",
          microBreakout: expect.objectContaining({
            side: "above",
            depthTicks: 2,
            thresholdTicks: 5
          })
        })
      })
    });
    expect(prisma.position.update).toHaveBeenCalledWith({
      where: { id: "position-row-1" },
      data: { lastAlertStatus: PositionStatus.above_range }
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
