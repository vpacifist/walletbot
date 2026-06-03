import { PositionStatus } from "@/generated/prisma/client";
import { Telegraf } from "telegraf";
import { getAddress } from "viem";
import { broadcastAutopilotRebalance, type AutopilotBroadcastResult } from "./autopilot-broadcaster";
import { createAutopilotDryRunExecution } from "./autopilot-executor";
import { getOrCreatePendingAutopilotPlan, recordAutopilotPlanDecision } from "./autopilot-service";
import { getConfig } from "./config";
import { prisma } from "./db";
import { formatNumber, shortAddress } from "./format";
import { getWalletAssetSnapshot } from "./wallet-assets";

const LOW_NATIVE_ETH_THRESHOLD_USD = 10;

function autopilotKeyboard(planId: string) {
  return {
    inline_keyboard: [
      [
        { text: "Approve", callback_data: `ap:approve:${planId}` },
        { text: "Skip", callback_data: `ap:skip:${planId}` },
        { text: "Pause", callback_data: `ap:pause:${planId}` }
      ]
    ]
  };
}

function autopilotManualReviewKeyboard(planId: string, reasons: string[] = []) {
  if (reasons.length === 1 && reasons[0] === "Boundary drift") {
    return {
      inline_keyboard: [
        [{ text: "Accept drift & review live transaction", callback_data: `ap:accept_drift:${planId}` }],
        [{ text: "Wait", callback_data: `ap:pause:${planId}` }]
      ]
    };
  }

  return autopilotKeyboard(planId);
}

function autopilotPlanNeedsAttention(plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"]) {
  if (plan.state === "idle" || plan.state === "paused" || plan.state === "cooldown") return false;
  return plan.actions.some((action) => action.type !== "hold" && action.type !== "wait");
}

function autopilotIncidentDedupeKey(plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"], planKey: string) {
  const active = plan.ladder.find((segment) => segment.role === "active");
  const closeAction = plan.actions.find((action) => action.type === "close" && action.tokenId);

  if (plan.strategy.preset === "small_capital_test" && active?.tokenId && closeAction?.tokenId) {
    const direction =
      plan.pool.currentTick < active.lowerTick
        ? "below_range"
        : plan.pool.currentTick >= active.upperTick
          ? "above_range"
          : "rebalance";
    return `autopilot-incident:${plan.strategy.preset}:${active.tokenId}:${active.lowerTick}:${active.upperTick}:${direction}`;
  }

  return `autopilot-plan:${planKey}`;
}

async function recordAutopilotPlanEvent(input: {
  dedupeKey: string;
  plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"];
  planId: string;
  planKey: string;
}) {
  const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey: input.dedupeKey } });
  if (existing) return existing;

  return prisma.telegramEvent.create({
    data: {
      alertType: "autopilot_plan",
      dedupeKey: input.dedupeKey,
      payload: {
        planId: input.planId,
        planKey: input.planKey,
        state: input.plan.state,
        title: input.plan.title
      }
    }
  });
}

function retryablePriceMovementFailure(result: AutopilotBroadcastResult) {
  return !result.success && /Swap price moved beyond slippage tolerance|retry with a fresh plan/i.test(result.error ?? "");
}

async function sendAutoGuardedBlocked(bot: Telegraf, planId: string, summary: string, reasons: string[] = []) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return;

  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    ["Auto-guarded blocked", `Plan id: ${planId}`, reasons.length > 0 ? `Reason: ${reasons.join("; ")}` : undefined, "", summary].filter(Boolean).join("\n"),
    { reply_markup: autopilotManualReviewKeyboard(planId, reasons) }
  );
}

async function executeAutoGuardedPlan(
  bot: Telegraf,
  autopilotPlan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>,
  dedupeKey: string,
  retried = false
) {
  const { TELEGRAM_CHAT_ID, BLOCKSCOUT_BASE_URL } = getConfig();
  if (!TELEGRAM_CHAT_ID) return { sent: 0, skipped: "telegram_not_configured" };

  const approved = await recordAutopilotPlanDecision(autopilotPlan.record.id, "approved");
  const execution = await createAutopilotDryRunExecution(approved.id, { allowUncoveredDebt: true });

  if (execution.status !== "validated") {
    await sendAutoGuardedBlocked(bot, approved.id, execution.telegramSummary, execution.checks.filter((check) => !check.ok).map((check) => check.label));
    await recordAutopilotPlanEvent({
      dedupeKey,
      plan: autopilotPlan.plan,
      planId: approved.id,
      planKey: approved.planKey
    });
    return { sent: 1, planId: approved.id, autoGuarded: "blocked" };
  }

  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    [
      retried ? "Auto-guarded refreshed rebalance is being sent" : "Auto-guarded rebalance is being sent",
      `Plan id: ${approved.id}`,
      "Uncovered debt is accepted automatically in auto_guarded mode.",
      "",
      "Prepared operations",
      ...execution.operations.map((operation, index) => `${index + 1}. ${operation.label}: ${operation.detail}`)
    ].join("\n")
  );

  const result = await broadcastAutopilotRebalance(approved.id, { allowUncoveredDebt: true });
  if (result.success && result.txHash) {
    const explorerUrl = `${BLOCKSCOUT_BASE_URL}/tx/${result.txHash}`;
    await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID,
      ["Auto-guarded rebalance sent", `Plan id: ${approved.id}`, `Tx Hash: ${result.txHash}`, `Blockscout: ${explorerUrl}`].join("\n")
    );
    await recordAutopilotPlanEvent({
      dedupeKey,
      plan: autopilotPlan.plan,
      planId: approved.id,
      planKey: approved.planKey
    });
    return { sent: 1, planId: approved.id, autoGuarded: "sent", txHash: result.txHash };
  }

  if (!retried && retryablePriceMovementFailure(result)) {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "Auto-guarded price moved during preflight. Rebuilding a fresh plan and quote...");
    const refreshed = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID });
    return executeAutoGuardedPlan(bot, refreshed, dedupeKey, true);
  }

  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    ["Auto-guarded execution failed", `Plan id: ${approved.id}`, result.error ?? "Unknown error", "", "Manual review is required."].join("\n"),
    { reply_markup: autopilotKeyboard(approved.id) }
  );
  await recordAutopilotPlanEvent({
    dedupeKey,
    plan: autopilotPlan.plan,
    planId: approved.id,
    planKey: approved.planKey
  });
  return { sent: 1, planId: approved.id, autoGuarded: "failed" };
}

export function isOutOfRange(status: PositionStatus) {
  return status === PositionStatus.above_range || status === PositionStatus.below_range;
}

export function getMoscowDateKey(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Moscow",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export async function sendOutOfRangeAlerts(bot: Telegraf) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return { sent: 0 };

  const positions = await prisma.position.findMany({
    where: {
      status: { in: [PositionStatus.above_range, PositionStatus.below_range] }
    },
    include: { wallet: true }
  });

  let sent = 0;
  let skippedAutopilotPlanMessage = 0;

  for (const position of positions) {
    if (isOutOfRange(position.lastAlertStatus ?? PositionStatus.unknown)) continue;

    const dedupeKey = `out-of-range:${position.id}:${position.status}:${position.currentTick ?? "na"}`;
    const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey } });
    if (existing) continue;

    const direction = position.status === PositionStatus.above_range ? "above range" : "below range";
    const autopilotPlan = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID }).catch(() => null);
    const autopilotIncidentAlreadyHandled = autopilotPlan
      ? await prisma.telegramEvent.findUnique({ where: { dedupeKey: autopilotIncidentDedupeKey(autopilotPlan.plan, autopilotPlan.record.planKey) } })
      : null;
    if (autopilotPlan && autopilotPlanNeedsAttention(autopilotPlan.plan) && (autopilotPlan.record.telegramMessageId || autopilotIncidentAlreadyHandled)) {
      await prisma.telegramEvent.create({
        data: {
          positionId: position.id,
          alertType: "out_of_range",
          dedupeKey,
          payload: {
            tokenId: position.tokenId,
            status: position.status,
            currentTick: position.currentTick,
            skippedBecause: autopilotPlan.record.telegramMessageId ? "autopilot_plan_message_exists" : "autopilot_incident_already_handled",
            planId: autopilotPlan.record.id
          }
        }
      });
      await prisma.position.update({
        where: { id: position.id },
        data: { lastAlertStatus: position.status }
      });
      skippedAutopilotPlanMessage += 1;
      continue;
    }
    const planSummary = autopilotPlan ? ["", "Autopilot plan", autopilotPlan.plan.telegramSummary, "", `Plan id: ${autopilotPlan.record.id}`].join("\n") : "";

    const message = await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID,
      [
        `Uniswap v3 WETH/USDC position #${position.tokenId} is ${direction}.`,
        `Wallet: ${shortAddress(position.wallet.address)}`,
        `Tick: ${position.currentTick ?? "unknown"} | Range: ${position.tickLower} - ${position.tickUpper}`,
        position.poolAddress ? `Pool: ${shortAddress(position.poolAddress)}` : undefined,
        planSummary || undefined
      ]
        .filter(Boolean)
        .join("\n"),
      autopilotPlan ? { reply_markup: autopilotKeyboard(autopilotPlan.record.id) } : undefined
    );

    if (autopilotPlan) {
      await prisma.rebalancePlan.update({
        where: { id: autopilotPlan.record.id },
        data: {
          telegramChatId: String(message.chat.id),
          telegramMessageId: String(message.message_id)
        }
      });
    }

    await prisma.telegramEvent.create({
      data: {
        positionId: position.id,
        alertType: "out_of_range",
        dedupeKey,
        payload: {
          tokenId: position.tokenId,
          status: position.status,
          currentTick: position.currentTick
        }
      }
    });
    await prisma.position.update({
      where: { id: position.id },
      data: { lastAlertStatus: position.status }
    });
    sent += 1;
  }

  await prisma.position.updateMany({
    where: {
      status: PositionStatus.in_range,
      lastAlertStatus: { in: [PositionStatus.above_range, PositionStatus.below_range] }
    },
    data: { lastAlertStatus: PositionStatus.in_range }
  });

  return { sent, skippedAutopilotPlanMessage };
}

export async function sendAutopilotPlanAlert(bot: Telegraf) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return { sent: 0, skipped: "telegram_not_configured" };

  const autopilotPlan = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID });
  if (!autopilotPlanNeedsAttention(autopilotPlan.plan)) {
    await prisma.telegramEvent.deleteMany({
      where: {
        alertType: "autopilot_plan",
        dedupeKey: { startsWith: "autopilot-incident:" }
      }
    });
    return { sent: 0, skipped: "plan_does_not_need_attention" };
  }
  const dedupeKey = autopilotIncidentDedupeKey(autopilotPlan.plan, autopilotPlan.record.planKey);
  const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey } });
  if (existing) return { sent: 0, skipped: "duplicate_plan_key" };
  if (autopilotPlan.plan.mode === "auto_guarded") {
    return executeAutoGuardedPlan(bot, autopilotPlan, dedupeKey);
  }
  if (autopilotPlan.record.telegramMessageId) {
    await recordAutopilotPlanEvent({
      dedupeKey,
      plan: autopilotPlan.plan,
      planId: autopilotPlan.record.id,
      planKey: autopilotPlan.record.planKey
    });
    return { sent: 0, skipped: "plan_already_has_telegram_message" };
  }

  const message = await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    [autopilotPlan.plan.telegramSummary, "", `Plan id: ${autopilotPlan.record.id}`].join("\n"),
    { reply_markup: autopilotKeyboard(autopilotPlan.record.id) }
  );

  await prisma.rebalancePlan.update({
    where: { id: autopilotPlan.record.id },
    data: {
      telegramChatId: String(message.chat.id),
      telegramMessageId: String(message.message_id)
    }
  });

  await recordAutopilotPlanEvent({
    dedupeKey,
    plan: autopilotPlan.plan,
    planId: autopilotPlan.record.id,
    planKey: autopilotPlan.record.planKey
  });

  return { sent: 1, planId: autopilotPlan.record.id };
}

export async function sendLowNativeEthAlert(bot: Telegraf, now = new Date()) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return { sent: 0 };

  const wallet = await prisma.wallet.findFirst({ where: { enabled: true } });
  if (!wallet) return { sent: 0 };

  const snapshot = await getWalletAssetSnapshot(getAddress(wallet.address));
  if (snapshot.eth.valueUsd === null || snapshot.eth.valueUsd >= LOW_NATIVE_ETH_THRESHOLD_USD) return { sent: 0 };

  const dedupeKey = `low-native-eth:${wallet.id}:${getMoscowDateKey(now)}`;
  const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey } });
  if (existing) return { sent: 0 };

  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    [
      `Native ETH balance is below $${LOW_NATIVE_ETH_THRESHOLD_USD}.`,
      `Wallet: ${shortAddress(wallet.address)}`,
      `ETH: ${formatNumber(snapshot.eth.amount, 6)} ($${formatNumber(snapshot.eth.valueUsd, 2)})`
    ].join("\n")
  );

  await prisma.telegramEvent.create({
    data: {
      alertType: "low_native_eth",
      dedupeKey,
      payload: {
        walletId: wallet.id,
        walletAddress: wallet.address,
        ethAmount: snapshot.eth.amount,
        ethValueUsd: snapshot.eth.valueUsd,
        thresholdUsd: LOW_NATIVE_ETH_THRESHOLD_USD
      }
    }
  });

  return { sent: 1 };
}
