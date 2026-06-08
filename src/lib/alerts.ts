import { PositionStatus } from "@/generated/prisma/client";
import { Telegraf } from "telegraf";
import { getAddress } from "viem";
import { autopilotBreakoutDepthTicks, autopilotBreakoutSide } from "./autopilot-breakout";
import { broadcastAutopilotRebalance, type AutopilotBroadcastOptions, type AutopilotBroadcastResult } from "./autopilot-broadcaster";
import { createAutopilotDryRunExecution } from "./autopilot-executor";
import { isAutopilotRuntimePaused } from "./autopilot-pause";
import { getOrCreatePendingAutopilotPlan, recordAutopilotPlanDecision } from "./autopilot-service";
import { getConfig } from "./config";
import { prisma } from "./db";
import { formatNumber, shortAddress } from "./format";
import { syncWalletOnce } from "./sync";
import { getWalletAssetSnapshot } from "./wallet-assets";

const LOW_NATIVE_ETH_THRESHOLD_USD = 10;
const SUSTAINED_BREAKOUT_DRIFT_TICKS = 30;
const SUSTAINED_BREAKOUT_WAIT_MS = 15 * 60 * 1000;

let autoGuardedExecutionRunning = false;

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

function autopilotMicroBreakoutSkip(plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"]) {
  const config = getConfig();
  if (plan.mode !== "auto_guarded") return null;
  if (config.AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS <= 0) return null;

  const active = plan.ladder.find((segment) => segment.role === "active");
  if (!active) return null;

  const side = autopilotBreakoutSide(plan.pool.currentTick, active);
  if (!side) return null;

  const depthTicks = autopilotBreakoutDepthTicks(plan.pool.currentTick, active);
  if (depthTicks >= config.AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS) return null;

  return {
    side,
    depthTicks,
    tokenId: active.tokenId,
    lowerTick: active.lowerTick,
    upperTick: active.upperTick,
    thresholdTicks: config.AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS
  };
}

function autoGuardedDedupeExpired(sentAt: Date) {
  const retryMs = getConfig().AUTOPILOT_AUTO_RETRY_DEDUPE_MS;
  return retryMs > 0 && Date.now() - sentAt.getTime() >= retryMs;
}

function sustainedWaitDedupeKey(incidentDedupeKey: string) {
  return `autopilot-sustained-wait:${incidentDedupeKey}`;
}

function activeAutopilotRange(plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"]) {
  return plan.ladder.find((segment) => segment.role === "active" && segment.tokenId) ?? null;
}

function currentBreakoutDepth(plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"]) {
  const active = activeAutopilotRange(plan);
  if (!active) return null;

  const side = autopilotBreakoutSide(plan.pool.currentTick, active);
  if (!side) return null;

  return {
    side,
    depthTicks: autopilotBreakoutDepthTicks(plan.pool.currentTick, active),
    tokenId: active.tokenId,
    lowerTick: active.lowerTick,
    upperTick: active.upperTick
  };
}

function sustainedBreakoutMessage(input: {
  planId: string;
  depthTicks: number;
  side: "above" | "below";
  tokenId: string | null;
  lowerTick: number;
  upperTick: number;
  summary: string;
}) {
  return [
    "Auto-guarded sustained breakout watch",
    `Plan id: ${input.planId}`,
    `Position: ${input.tokenId ? `#${input.tokenId}` : "active range"}`,
    `Range: ${input.lowerTick} - ${input.upperTick}`,
    `Breakout: ${input.depthTicks} ticks ${input.side} boundary`,
    `Action: waiting 15 minutes. If drift falls below ${SUSTAINED_BREAKOUT_DRIFT_TICKS} ticks, auto-rebalance will run immediately. If it stays ${SUSTAINED_BREAKOUT_DRIFT_TICKS}+ ticks, auto-rebalance will run after the wait.`,
    "",
    input.summary
  ].join("\n");
}

async function maybeWaitForSustainedBreakout(
  bot: Telegraf,
  autopilotPlan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>,
  dedupeKey: string
) {
  const breakout = currentBreakoutDepth(autopilotPlan.plan);
  const waitKey = sustainedWaitDedupeKey(dedupeKey);

  if (!breakout || breakout.depthTicks < SUSTAINED_BREAKOUT_DRIFT_TICKS) {
    await prisma.telegramEvent.deleteMany({
      where: {
        alertType: "autopilot_sustained_wait",
        dedupeKey: waitKey
      }
    });
    return { status: "execute" as const, allowBoundaryDrift: false };
  }

  const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey: waitKey } });
  if (!existing) {
    await prisma.telegramEvent.create({
      data: {
        alertType: "autopilot_sustained_wait",
        dedupeKey: waitKey,
        payload: {
          planId: autopilotPlan.record.id,
          planKey: autopilotPlan.record.planKey,
          tokenId: breakout.tokenId,
          side: breakout.side,
          depthTicks: breakout.depthTicks,
          lowerTick: breakout.lowerTick,
          upperTick: breakout.upperTick,
          waitMs: SUSTAINED_BREAKOUT_WAIT_MS
        }
      }
    });
    await bot.telegram.sendMessage(
      getConfig().TELEGRAM_CHAT_ID!,
      sustainedBreakoutMessage({
        planId: autopilotPlan.record.id,
        depthTicks: breakout.depthTicks,
        side: breakout.side,
        tokenId: breakout.tokenId,
        lowerTick: breakout.lowerTick,
        upperTick: breakout.upperTick,
        summary: autopilotPlan.plan.telegramSummary
      })
    );
    return { status: "waiting" as const, sent: 1, depthTicks: breakout.depthTicks, waitRemainingMs: SUSTAINED_BREAKOUT_WAIT_MS };
  }

  const waitRemainingMs = SUSTAINED_BREAKOUT_WAIT_MS - (Date.now() - existing.sentAt.getTime());
  if (waitRemainingMs > 0) {
    return { status: "waiting" as const, sent: 0, depthTicks: breakout.depthTicks, waitRemainingMs };
  }

  return { status: "execute" as const, allowBoundaryDrift: true, depthTicks: breakout.depthTicks };
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

function formatUsd(value: number) {
  return `$${formatNumber(value, 2)}`;
}

function formatPriceRange(lowerPrice: number | null, upperPrice: number | null) {
  if (lowerPrice === null || upperPrice === null) return "-";
  return `${formatUsd(lowerPrice)} - ${formatUsd(upperPrice)}`;
}

function buildAutoGuardedPostCheckSummary(plan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>["plan"], txHash: string) {
  const active = plan.ladder.find((segment) => segment.role === "active");
  const primaryAction = plan.actions[0];
  const lastSwap = plan.economics.lastDirectionalSwap;

  return [
    "Auto-guarded post-check",
    `State: ${plan.state}`,
    `Price: ${formatUsd(plan.pool.price)} | Tick ${plan.pool.currentTick}`,
    active
      ? `Active range: ${active.tokenId ? `#${active.tokenId} ` : ""}${active.range} (${formatPriceRange(active.lowerPrice, active.upperPrice)})`
      : "Active range: not found",
    `Next: ${primaryAction?.label ?? "No action"}`,
    `Reversal debt: ${formatUsd(plan.economics.reversalDebtUsd)}`,
    `Fee credit: ${formatUsd(plan.economics.feeCreditUsd)}`,
    `Uncovered debt: ${formatUsd(plan.economics.uncoveredReversalDebtUsd)}`,
    lastSwap ? `Last directional swap: ${lastSwap.side === "sell_weth" ? "Sold WETH" : "Bought WETH"} @ ${formatUsd(lastSwap.effectivePrice)}` : undefined,
    `Tx: ${shortAddress(txHash)}`
  ]
    .filter(Boolean)
    .join("\n");
}

function checkText(execution: { checks: Array<{ label: string; detail: string }> }, label: string) {
  return execution.checks.find((check) => check.label === label)?.detail;
}

function autoGuardedBlockedMessage(planId: string, summary: string, reasons: string[], execution?: { checks: Array<{ label: string; detail: string; ok: boolean }> }) {
  if (!reasons.includes("Boundary drift") || !execution) {
    return ["Auto-guarded blocked", `Plan id: ${planId}`, reasons.length > 0 ? `Reason: ${reasons.join("; ")}` : undefined, "", summary].filter(Boolean).join("\n");
  }

  return [
    "Auto-guarded blocked: Boundary drift",
    `Plan id: ${planId}`,
    "Price moved too far from the crossed range boundary for automatic execution.",
    `Boundary drift: ${checkText(execution, "Boundary drift") ?? "above normal limit"}`,
    `Uncovered debt: ${checkText(execution, "Uncovered debt") ?? "not available"}`,
    `Immediate cost: ${checkText(execution, "Immediate cost") ?? "not available"}`,
    "",
    "Accept drift only if you want to rebalance despite the worse boundary price. Other guardrails still apply.",
    "",
    summary
  ].join("\n");
}

async function sendAutoGuardedPostCheck(bot: Telegraf, txHash: string) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return;

  try {
    await syncWalletOnce();
    const postCheck = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID });
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, buildAutoGuardedPostCheckSummary(postCheck.plan, txHash));
  } catch (error) {
    await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID,
      [
        "Auto-guarded post-check failed",
        `Tx: ${shortAddress(txHash)}`,
        error instanceof Error ? error.message : "Unable to refresh the plan after execution.",
        "Use /autopilot to refresh manually."
      ].join("\n")
    );
  }
}

async function sendAutoGuardedBlocked(bot: Telegraf, planId: string, summary: string, reasons: string[] = [], execution?: { checks: Array<{ label: string; detail: string; ok: boolean }> }) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return;

  await bot.telegram.sendMessage(
    TELEGRAM_CHAT_ID,
    autoGuardedBlockedMessage(planId, summary, reasons, execution),
    { reply_markup: autopilotManualReviewKeyboard(planId, reasons) }
  );
}

async function executeAutoGuardedPlan(
  bot: Telegraf,
  autopilotPlan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>,
  dedupeKey: string,
  retried = false,
  options: AutopilotBroadcastOptions = {}
) {
  if (autoGuardedExecutionRunning) return { sent: 0, skipped: "auto_guarded_already_running" };
  autoGuardedExecutionRunning = true;
  try {
    return await executeAutoGuardedPlanInner(bot, autopilotPlan, dedupeKey, retried, options);
  } finally {
    autoGuardedExecutionRunning = false;
  }
}

async function executeAutoGuardedPlanInner(
  bot: Telegraf,
  autopilotPlan: Awaited<ReturnType<typeof getOrCreatePendingAutopilotPlan>>,
  dedupeKey: string,
  retried = false,
  options: AutopilotBroadcastOptions = {}
) {
  const { TELEGRAM_CHAT_ID, BLOCKSCOUT_BASE_URL } = getConfig();
  if (!TELEGRAM_CHAT_ID) return { sent: 0, skipped: "telegram_not_configured" };

  const approved = await recordAutopilotPlanDecision(autopilotPlan.record.id, "approved");
  const autoExecutionOptions = { allowUncoveredDebt: true, allowEquivalentPlanFreshness: true, ...options };
  const execution = await createAutopilotDryRunExecution(approved.id, autoExecutionOptions);

  if (execution.status !== "validated") {
    await sendAutoGuardedBlocked(bot, approved.id, execution.telegramSummary, execution.checks.filter((check) => !check.ok).map((check) => check.label), execution);
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
      autoExecutionOptions.allowBoundaryDrift ? "Boundary drift is accepted after the 15-minute sustained breakout wait." : undefined,
      "",
      "Prepared operations",
      ...execution.operations.map((operation, index) => `${index + 1}. ${operation.label}: ${operation.detail}`)
    ].filter((line) => line !== undefined).join("\n")
  );

  const result = await broadcastAutopilotRebalance(approved.id, autoExecutionOptions);
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
    await sendAutoGuardedPostCheck(bot, result.txHash);
    return { sent: 1, planId: approved.id, autoGuarded: "sent", txHash: result.txHash };
  }

  if (!retried && retryablePriceMovementFailure(result)) {
    await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, "Auto-guarded price moved during preflight. Rebuilding a fresh plan and quote...");
    const refreshed = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID });
    return executeAutoGuardedPlanInner(bot, refreshed, dedupeKey, true, options);
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
    const microBreakout = autopilotPlan ? autopilotMicroBreakoutSkip(autopilotPlan.plan) : null;
    const autoGuardedExecutionInFlight = autoGuardedExecutionRunning && autopilotPlan?.plan.mode === "auto_guarded";
    if (
      autopilotPlan &&
      autopilotPlanNeedsAttention(autopilotPlan.plan) &&
      (autopilotPlan.record.telegramMessageId || autopilotIncidentAlreadyHandled || microBreakout || autoGuardedExecutionInFlight)
    ) {
      await prisma.telegramEvent.create({
        data: {
          positionId: position.id,
          alertType: "out_of_range",
          dedupeKey,
          payload: {
            tokenId: position.tokenId,
            status: position.status,
            currentTick: position.currentTick,
            skippedBecause: autopilotPlan.record.telegramMessageId
              ? "autopilot_plan_message_exists"
              : autoGuardedExecutionInFlight
                ? "auto_guarded_execution_running"
              : microBreakout
                ? "autopilot_micro_breakout"
                : "autopilot_incident_already_handled",
            microBreakout,
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

  const runtimePaused = await isAutopilotRuntimePaused();
  const autopilotPlan = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID });
  if (!autopilotPlanNeedsAttention(autopilotPlan.plan)) {
    await prisma.telegramEvent.deleteMany({
      where: {
        OR: [
          {
            alertType: "autopilot_plan",
            dedupeKey: { startsWith: "autopilot-incident:" }
          },
          {
            alertType: "autopilot_sustained_wait",
            dedupeKey: { startsWith: "autopilot-sustained-wait:autopilot-incident:" }
          }
        ]
      }
    });
    return { sent: 0, skipped: "plan_does_not_need_attention" };
  }
  const microBreakout = autopilotMicroBreakoutSkip(autopilotPlan.plan);
  if (microBreakout) {
    return { sent: 0, skipped: "micro_breakout", ...microBreakout };
  }
  const dedupeKey = autopilotIncidentDedupeKey(autopilotPlan.plan, autopilotPlan.record.planKey);
  const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey } });
  if (existing) {
    if (autopilotPlan.plan.mode === "auto_guarded" && !runtimePaused && autoGuardedDedupeExpired(existing.sentAt)) {
      await prisma.telegramEvent.deleteMany({
        where: {
          alertType: "autopilot_plan",
          dedupeKey
        }
      });
    } else {
      return { sent: 0, skipped: "duplicate_plan_key" };
    }
  }
  if (autopilotPlan.plan.mode === "auto_guarded" && !runtimePaused) {
    const sustained = await maybeWaitForSustainedBreakout(bot, autopilotPlan, dedupeKey);
    if (sustained.status === "waiting") {
      return {
        sent: sustained.sent,
        planId: autopilotPlan.record.id,
        autoGuarded: "sustained_wait",
        depthTicks: sustained.depthTicks,
        waitRemainingMs: sustained.waitRemainingMs
      };
    }
    return executeAutoGuardedPlan(bot, autopilotPlan, dedupeKey, false, sustained.allowBoundaryDrift ? { allowBoundaryDrift: true } : {});
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

export async function retryCurrentAutopilotIncident(bot: Telegraf) {
  const { TELEGRAM_CHAT_ID } = getConfig();
  if (!TELEGRAM_CHAT_ID) return { sent: 0, skipped: "telegram_not_configured" };

  const autopilotPlan = await getOrCreatePendingAutopilotPlan({ telegramChatId: TELEGRAM_CHAT_ID });
  if (!autopilotPlanNeedsAttention(autopilotPlan.plan)) {
    return { sent: 0, skipped: "plan_does_not_need_attention" };
  }

  const dedupeKey = autopilotIncidentDedupeKey(autopilotPlan.plan, autopilotPlan.record.planKey);
  await prisma.telegramEvent.deleteMany({
    where: {
      alertType: "autopilot_plan",
      dedupeKey
    }
  });

  await bot.telegram.sendMessage(TELEGRAM_CHAT_ID, ["Retrying current autopilot incident", `Plan id: ${autopilotPlan.record.id}`].join("\n"));
  return sendAutopilotPlanAlert(bot);
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
