import { Context, Telegraf } from "telegraf";
import { retryCurrentAutopilotIncident } from "@/lib/alerts";
import { broadcastAutopilotRebalance, type AutopilotBroadcastOptions, type AutopilotBroadcastResult } from "@/lib/autopilot-broadcaster";
import { createAutopilotDryRunExecution } from "@/lib/autopilot-executor";
import { pauseAutopilotRuntime, resumeAutopilotRuntime } from "@/lib/autopilot-pause";
import { createAutopilotExecutionPreview } from "@/lib/autopilot-execution-preview";
import { getOrCreatePendingAutopilotPlan, recordAutopilotPlanDecision } from "@/lib/autopilot-service";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { shortAddress } from "@/lib/format";
import { getWebAppUrl } from "@/lib/web-app-url";

const AUTOPILOT_DECISION_PATTERN = /^ap:(approve|skip|pause):(.+)$/;
const AUTOPILOT_EXECUTE_PATTERN = /^ap:execute:(.+)$/;
const AUTOPILOT_ACCEPT_DEBT_PATTERN = /^ap:accept_debt:(.+)$/;
const AUTOPILOT_ACCEPT_DRIFT_PATTERN = /^ap:accept_drift:(.+)$/;
const AUTOPILOT_ACCEPT_DEBT_DRIFT_PATTERN = /^ap:accept_debt_drift:(.+)$/;
const AUTOPILOT_LIVE_REVIEW_PATTERN = /^ap:live_review:(.+)$/;
const AUTOPILOT_LIVE_EXECUTE_PATTERN = /^ap:execute_live:(.+)$/;
const AUTOPILOT_LIVE_EXECUTE_DEBT_PATTERN = /^ap:execute_live_debt:(.+)$/;
const AUTOPILOT_LIVE_EXECUTE_DRIFT_PATTERN = /^ap:execute_live_drift:(.+)$/;
const AUTOPILOT_LIVE_EXECUTE_DEBT_DRIFT_PATTERN = /^ap:execute_live_debt_drift:(.+)$/;
const AUTOPILOT_RETRY_CURRENT_PATTERN = /^ap:retry_current$/;

function telegramSafeMessage(message: string, maxLength = 3_800) {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 80)}\n\n[message truncated; see Railway logs or plan history for full details]`;
}

function assertAllowedChat(ctx: Context) {
  const expected = getConfig().TELEGRAM_CHAT_ID;
  if (!expected) return false;
  const chatId = ctx.chat?.id ?? (ctx.callbackQuery?.message && "chat" in ctx.callbackQuery.message ? ctx.callbackQuery.message.chat.id : undefined);
  return String(chatId) === expected;
}

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

function autopilotExecutionKeyboard(planId: string) {
  return {
    inline_keyboard: [
      [{ text: "Run executor dry-run", callback_data: `ap:execute:${planId}` }]
    ]
  };
}

function autopilotAcceptDebtKeyboard(planId: string) {
  return {
    inline_keyboard: [
      [{ text: "Accept debt & review live transaction", callback_data: `ap:accept_debt:${planId}` }],
      [{ text: "Wait", callback_data: `ap:pause:${planId}` }]
    ]
  };
}

function autopilotAcceptDriftKeyboard(planId: string) {
  return {
    inline_keyboard: [
      [{ text: "Accept drift & review live transaction", callback_data: `ap:accept_drift:${planId}` }],
      [{ text: "Wait", callback_data: `ap:pause:${planId}` }]
    ]
  };
}

function autopilotAcceptDebtDriftKeyboard(planId: string) {
  return {
    inline_keyboard: [
      [{ text: "Accept debt + drift & review live transaction", callback_data: `ap:accept_debt_drift:${planId}` }],
      [{ text: "Wait", callback_data: `ap:pause:${planId}` }]
    ]
  };
}

function autopilotLiveKeyboard(planId: string) {
  const config = getConfig();
  const executorPrivateKey = config.AUTOPILOT_EXECUTOR_PRIVATE_KEY || config.BASE_WALLET_PRIVATE_KEY;
  if (!config.AUTOPILOT_LIVE_EXECUTION_ENABLED || !executorPrivateKey || !config.AUTOPILOT_REBALANCER_ADDRESS) return undefined;
  return {
    inline_keyboard: [
      [{ text: "Review live transaction", callback_data: `ap:live_review:${planId}` }]
    ]
  };
}

function autopilotLiveConfirmKeyboard(planId: string, options: AutopilotBroadcastOptions & { refreshed?: boolean } = {}) {
  const callbackPrefix =
    options.allowUncoveredDebt && options.allowBoundaryDrift
      ? "ap:execute_live_debt_drift"
      : options.allowUncoveredDebt
        ? "ap:execute_live_debt"
        : options.allowBoundaryDrift
          ? "ap:execute_live_drift"
          : "ap:execute_live";
  const confirmText = options.allowUncoveredDebt && options.allowBoundaryDrift
    ? "Confirm accepted-risk transaction"
    : options.allowUncoveredDebt
    ? "Confirm accepted-debt transaction"
    : options.allowBoundaryDrift
      ? "Confirm accepted-drift transaction"
      : "Confirm live transaction";
  return {
    inline_keyboard: [
      [
        {
          text: options.refreshed ? "Confirm refreshed transaction" : confirmText,
          callback_data: `${callbackPrefix}:${planId}`
        },
        { text: options.refreshed ? "Wait" : "Cancel", callback_data: `ap:pause:${planId}` }
      ]
    ]
  };
}

function webKeyboard() {
  return {
    inline_keyboard: [[{ text: "Open WalletBot web", url: getWebAppUrl() }]]
  };
}

function decisionLabel(decision: string) {
  if (decision === "approved") return "Approved";
  if (decision === "skipped") return "Skipped";
  if (decision === "paused") return "Paused";
  return decision;
}

function configuredWalletWhere() {
  return { address: getConfig().BASE_WALLET_ADDRESS };
}

function blockedOnlyByUncoveredDebt(result: { status: string; reasons?: string[] }) {
  return result.status === "blocked" && result.reasons?.length === 1 && result.reasons[0] === "Uncovered debt";
}

function blockedOnlyByBoundaryDrift(result: { status: string; reasons?: string[] }) {
  return result.status === "blocked" && result.reasons?.length === 1 && result.reasons[0] === "Boundary drift";
}

function blockedOnlyByUncoveredDebtAndBoundaryDrift(result: { status: string; reasons?: string[] }) {
  const reasons = result.reasons ?? [];
  return result.status === "blocked" && reasons.length === 2 && reasons.includes("Uncovered debt") && reasons.includes("Boundary drift");
}

function uncoveredDebtText(execution: { checks: Array<{ label: string; detail: string }> }) {
  return execution.checks.find((check) => check.label === "Uncovered debt")?.detail;
}

function boundaryDriftText(execution: { checks: Array<{ label: string; detail: string }> }) {
  return execution.checks.find((check) => check.label === "Boundary drift")?.detail;
}

function checkText(execution: { checks: Array<{ label: string; detail: string }> }, label: string) {
  return execution.checks.find((check) => check.label === label)?.detail;
}

function blockedPreviewMessage(preview: Awaited<ReturnType<typeof createAutopilotExecutionPreview>>) {
  if (!preview.reasons.includes("Boundary drift")) return preview.telegramSummary;

  return [
    "Execution preview blocked: Boundary drift",
    "Price moved too far from the crossed range boundary for automatic execution.",
    `Current price: $${preview.pool.price.toLocaleString("en-US", { maximumFractionDigits: 2 })} | Tick ${preview.pool.currentTick}`,
    `Boundary drift: ${checkText(preview, "Boundary drift") ?? "above normal limit"}`,
    `Uncovered debt: ${checkText(preview, "Uncovered debt") ?? "not available"}`,
    `Immediate cost: ${checkText(preview, "Immediate cost") ?? "not available"}`,
    "",
    "Accept drift only if you want to rebalance despite the worse boundary price. Other guardrails still apply.",
    "",
    preview.telegramSummary
  ].join("\n");
}

function blockedExecutionMessage(title: string, execution: Awaited<ReturnType<typeof createAutopilotDryRunExecution>>) {
  const hasBoundaryDrift = execution.checks.some((check) => check.label === "Boundary drift" && !check.ok);
  if (!hasBoundaryDrift) return [title, "", execution.telegramSummary].join("\n");

  return [
    title,
    "",
    "Execution blocked: Boundary drift",
    "Price moved too far from the crossed range boundary for automatic execution.",
    `Boundary drift: ${boundaryDriftText(execution) ?? "above normal limit"}`,
    `Uncovered debt: ${checkText(execution, "Uncovered debt") ?? "not available"}`,
    `Immediate cost: ${checkText(execution, "Immediate cost") ?? "not available"}`,
    "",
    "Accepting drift may lock in a worse swap price. Stale plan, quote, preflight, roles, approval, route, and immediate-cost checks still apply.",
    "",
    execution.telegramSummary
  ].join("\n");
}

function liveReviewMessage(planId: string, execution: Awaited<ReturnType<typeof createAutopilotDryRunExecution>>, options: AutopilotBroadcastOptions & { refreshed?: boolean } = {}) {
  return [
    options.refreshed ? "Price moved, refreshed quote is ready" : "Live execution review",
    `Plan id: ${planId}`,
    "",
    options.refreshed ? "A fresh plan, quote, and dry-run were prepared after the previous preflight moved beyond tolerance." : undefined,
    options.refreshed ? "" : undefined,
    options.allowUncoveredDebt ? `You are accepting uncovered debt: ${uncoveredDebtText(execution) ?? "above normal limit"}` : undefined,
    options.allowUncoveredDebt ? "This may lock in a worse buyback/sell price." : undefined,
    options.allowBoundaryDrift ? `You are accepting boundary drift: ${boundaryDriftText(execution) ?? "above normal limit"}` : undefined,
    options.allowBoundaryDrift ? "This may lock in a worse swap price." : undefined,
    options.allowUncoveredDebt || options.allowBoundaryDrift ? "" : undefined,
    "This will submit one atomic rebalance transaction on Base from the configured executor wallet.",
    "Only continue if the dry-run output still matches the action you expect.",
    "",
    "Prepared operations",
    ...execution.operations.map((operation, index) => `${index + 1}. ${operation.label}: ${operation.detail}`),
    "",
    "Atomic transaction",
    execution.atomicCall.status === "prepared" ? `Target: ${execution.atomicCall.target}` : `Status: ${execution.atomicCall.status}`,
    execution.atomicCall.dataPreview ? `Calldata: ${execution.atomicCall.dataPreview}` : undefined,
    "",
    "Final confirmation is required before broadcasting."
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function retryablePriceMovementFailure(result: AutopilotBroadcastResult) {
  return !result.success && /Swap price moved beyond slippage tolerance|retry with a fresh plan/i.test(result.error ?? "");
}

const FAST_QUOTE_RETRY_LIMIT = 3;

async function sendSuccessfulExecution(ctx: Context, txHash: string) {
  const explorerUrl = `${getConfig().BLOCKSCOUT_BASE_URL}/tx/${txHash}`;
  await ctx.reply(
    [
      "**Transaction executed successfully on-chain!**",
      `Tx Hash: \`${txHash}\``,
      `[View on Blockscout](${explorerUrl})`
    ].join("\n"),
    { parse_mode: "Markdown" }
  );
}

async function broadcastWithFastQuoteRetries(ctx: Context, planId: string, options: AutopilotBroadcastOptions = {}) {
  const liveOptions = { ...options, allowEquivalentPlanFreshness: true };
  let currentPlanId = planId;
  let result = await broadcastAutopilotRebalance(currentPlanId, liveOptions);

  for (let attempt = 1; !result.success && retryablePriceMovementFailure(result) && attempt <= FAST_QUOTE_RETRY_LIMIT; attempt += 1) {
    await ctx.reply(`Price moved during preflight; retrying fresh quote ${attempt}/${FAST_QUOTE_RETRY_LIMIT}...`);

    const { record } = await getOrCreatePendingAutopilotPlan({
      telegramChatId: String(ctx.chat?.id ?? "")
    });
    const approved = await recordAutopilotPlanDecision(record.id, "approved");
    currentPlanId = approved.id;
    const execution = await createAutopilotDryRunExecution(currentPlanId, liveOptions);

    if (execution.status !== "validated") {
      await ctx.reply(blockedExecutionMessage("Fast quote retry stopped: refreshed plan is blocked.", execution));
      return { result, handled: true };
    }

    result = await broadcastAutopilotRebalance(currentPlanId, liveOptions);
  }

  return { result, handled: false };
}

async function replyWithLiveExecutionResult(
  ctx: Context,
  planId: string,
  options: AutopilotBroadcastOptions = {}
) {
  const { result, handled } = await broadcastWithFastQuoteRetries(ctx, planId, options);
  if (handled) return;

  if (result.success && result.txHash) {
    await sendSuccessfulExecution(ctx, result.txHash);
    return;
  }

  await ctx.reply(telegramSafeMessage(`**On-chain execution failed:**\n${result.error || "Unknown error"}`));
}

export function createBot() {
  const { TELEGRAM_BOT_TOKEN } = getConfig();
  if (!TELEGRAM_BOT_TOKEN) return null;

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => {
    if (!assertAllowedChat(ctx)) return;
    return ctx.reply("WalletBot is running. Use /status, /positions, /autopilot, /autopilot_pause, /autopilot_resume, or /web.");
  });

  bot.command("autopilot_pause", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;
    await pauseAutopilotRuntime("Paused from Telegram command");
    await ctx.reply("Auto-guarded execution is paused. Manual /autopilot review still works. Use /autopilot_resume to enable auto-guarded execution again.");
  });

  bot.command("autopilot_resume", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;
    await resumeAutopilotRuntime();
    await ctx.reply("Auto-guarded execution is resumed. Guardrails still apply before any automatic rebalance.");
  });

  bot.command("web", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;
    await ctx.reply("Open WalletBot web dashboard:", {
      reply_markup: webKeyboard()
    });
  });

  bot.command("status", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;
    const wallet = await prisma.wallet.findUnique({ where: configuredWalletWhere(), include: { positions: true } });
    const latestRun = await prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } });

    if (!wallet) {
      await ctx.reply("Wallet is not configured yet.");
      return;
    }

    const outOfRange = wallet.positions.filter((position) => position.status === "above_range" || position.status === "below_range");
    await ctx.reply(
      [
        `Wallet: ${shortAddress(wallet.address)}`,
        `Last synced block: ${wallet.lastSyncedBlock?.toString() ?? "never"}`,
        `Positions: ${wallet.positions.length}`,
        `Out of range: ${outOfRange.length}`,
        latestRun ? `Last sync: ${latestRun.status} at ${latestRun.startedAt.toISOString()}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    );
  });

  bot.command("positions", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;
    const wallet = await prisma.wallet.findUnique({ where: configuredWalletWhere() });
    const positions = wallet
      ? await prisma.position.findMany({ where: { walletId: wallet.id }, orderBy: { updatedAt: "desc" }, take: 10 })
      : [];
    if (positions.length === 0) {
      await ctx.reply("No WETH/USDC Uniswap v3 positions found yet.");
      return;
    }

    await ctx.reply(
      positions
        .map(
          (position) =>
            `#${position.tokenId}: ${position.status}\nTick ${position.currentTick ?? "?"} | Range ${position.tickLower} - ${position.tickUpper}\nLiquidity ${position.liquidity}`
        )
        .join("\n\n")
    );
  });

  bot.command("autopilot", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    try {
      const { plan, record } = await getOrCreatePendingAutopilotPlan({ telegramChatId: String(ctx.chat?.id ?? "") });
      const message = await ctx.reply([plan.telegramSummary, "", `Plan id: ${record.id}`].join("\n"), {
        reply_markup: autopilotKeyboard(record.id)
      });
      await prisma.rebalancePlan.update({
        where: { id: record.id },
        data: {
          telegramChatId: String(message.chat.id),
          telegramMessageId: String(message.message_id)
        }
      });
    } catch (error) {
      await ctx.reply(error instanceof Error ? `Autopilot plan unavailable: ${error.message}` : "Autopilot plan unavailable.");
    }
  });

  bot.command("autopilot_retry", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    try {
      await ctx.reply("Retrying current autopilot incident...");
      const result = await retryCurrentAutopilotIncident({ telegram: ctx.telegram } as Telegraf);
      await ctx.reply(
        [
          "Autopilot retry complete.",
          `Result: ${JSON.stringify(result)}`
        ].join("\n")
      );
    } catch (error) {
      await ctx.reply(error instanceof Error ? `Autopilot retry failed: ${error.message}` : "Autopilot retry failed.");
    }
  });

  bot.action(AUTOPILOT_DECISION_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const match = ctx.match;
    const action = match[1] as "approve" | "skip" | "pause";
    const planId = match[2];
    const decision = action === "approve" ? "approved" : action === "skip" ? "skipped" : "paused";

    try {
      const record = await recordAutopilotPlanDecision(planId, decision);
      await ctx.answerCbQuery(decisionLabel(record.status));
      await ctx.reply(
        [
          `Autopilot plan ${decisionLabel(record.status).toLowerCase()}.`,
          `Plan id: ${record.id}`,
          record.status === "approved" ? "Preparing dry-run execution preview." : undefined
        ]
          .filter(Boolean)
          .join("\n")
      );
      if (record.status === "approved") {
        const preview = await createAutopilotExecutionPreview(record.id);
        await ctx.reply(blockedPreviewMessage(preview), {
          reply_markup:
            preview.status === "ready"
              ? autopilotExecutionKeyboard(record.id)
              : blockedOnlyByUncoveredDebtAndBoundaryDrift(preview)
                ? autopilotAcceptDebtDriftKeyboard(record.id)
                : blockedOnlyByUncoveredDebt(preview)
                ? autopilotAcceptDebtKeyboard(record.id)
                : blockedOnlyByBoundaryDrift(preview)
                  ? autopilotAcceptDriftKeyboard(record.id)
                  : undefined
        });
      }
    } catch (error) {
      await ctx.answerCbQuery("Plan update failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Autopilot plan update failed: ${error.message}` : "Autopilot plan update failed.");
    }
  });

  bot.action(AUTOPILOT_RETRY_CURRENT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    try {
      await ctx.answerCbQuery("Retrying current incident...");
      const result = await retryCurrentAutopilotIncident({ telegram: ctx.telegram } as Telegraf);
      await ctx.reply(["Autopilot retry complete.", `Result: ${JSON.stringify(result)}`].join("\n"));
    } catch (error) {
      await ctx.answerCbQuery("Retry failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Autopilot retry failed: ${error.message}` : "Autopilot retry failed.");
    }
  });

  bot.action(AUTOPILOT_EXECUTE_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Executor dry-run started");
      const execution = await createAutopilotDryRunExecution(planId);
      const liveKeyboard = execution.status === "validated" ? autopilotLiveKeyboard(planId) : undefined;
      await ctx.reply(execution.status === "validated" ? execution.telegramSummary : blockedExecutionMessage("Executor dry-run blocked.", execution), {
        reply_markup: liveKeyboard
      });
    } catch (error) {
      await ctx.answerCbQuery("Executor dry-run failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Executor dry-run failed: ${error.message}` : "Executor dry-run failed.");
    }
  });

  bot.action(AUTOPILOT_ACCEPT_DEBT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Preparing accepted-debt live review...");
      const normalPreview = await createAutopilotExecutionPreview(planId);
      if (!blockedOnlyByUncoveredDebt(normalPreview)) {
        await ctx.reply(["Debt override is not available for this plan.", "", normalPreview.telegramSummary].join("\n"));
        return;
      }

      const execution = await createAutopilotDryRunExecution(planId, { allowUncoveredDebt: true });
      if (execution.status !== "validated") {
        await ctx.reply(["Accepted-debt live execution review blocked.", "", execution.telegramSummary].join("\n"));
        return;
      }

      await ctx.reply(liveReviewMessage(planId, execution, { allowUncoveredDebt: true }), {
        reply_markup: autopilotLiveConfirmKeyboard(planId, { allowUncoveredDebt: true })
      });
    } catch (error) {
      await ctx.answerCbQuery("Debt override failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Debt override failed: ${error.message}` : "Debt override failed.");
    }
  });

  bot.action(AUTOPILOT_ACCEPT_DRIFT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Preparing accepted-drift live review...");
      const normalPreview = await createAutopilotExecutionPreview(planId);
      if (!blockedOnlyByBoundaryDrift(normalPreview)) {
        await ctx.reply(["Drift override is not available for this plan.", "", normalPreview.telegramSummary].join("\n"));
        return;
      }

      const execution = await createAutopilotDryRunExecution(planId, { allowBoundaryDrift: true });
      if (execution.status !== "validated") {
        await ctx.reply(blockedExecutionMessage("Accepted-drift live execution review blocked.", execution));
        return;
      }

      await ctx.reply(liveReviewMessage(planId, execution, { allowBoundaryDrift: true }), {
        reply_markup: autopilotLiveConfirmKeyboard(planId, { allowBoundaryDrift: true })
      });
    } catch (error) {
      await ctx.answerCbQuery("Drift override failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Drift override failed: ${error.message}` : "Drift override failed.");
    }
  });

  bot.action(AUTOPILOT_ACCEPT_DEBT_DRIFT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Preparing accepted-risk live review...");
      const normalPreview = await createAutopilotExecutionPreview(planId);
      if (!blockedOnlyByUncoveredDebtAndBoundaryDrift(normalPreview)) {
        await ctx.reply(["Debt + drift override is not available for this plan.", "", normalPreview.telegramSummary].join("\n"));
        return;
      }

      const execution = await createAutopilotDryRunExecution(planId, { allowUncoveredDebt: true, allowBoundaryDrift: true });
      if (execution.status !== "validated") {
        await ctx.reply(blockedExecutionMessage("Accepted-risk live execution review blocked.", execution));
        return;
      }

      await ctx.reply(liveReviewMessage(planId, execution, { allowUncoveredDebt: true, allowBoundaryDrift: true }), {
        reply_markup: autopilotLiveConfirmKeyboard(planId, { allowUncoveredDebt: true, allowBoundaryDrift: true })
      });
    } catch (error) {
      await ctx.answerCbQuery("Risk override failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Risk override failed: ${error.message}` : "Risk override failed.");
    }
  });

  bot.action(AUTOPILOT_LIVE_REVIEW_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Preparing live review...");
      const execution = await createAutopilotDryRunExecution(planId);

      if (execution.status !== "validated") {
        await ctx.reply(blockedExecutionMessage("Live execution review blocked.", execution));
        return;
      }

      await ctx.reply(liveReviewMessage(planId, execution), {
        reply_markup: autopilotLiveConfirmKeyboard(planId)
      });
    } catch (error) {
      await ctx.answerCbQuery("Live review failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Live review failed: ${error.message}` : "Live review failed.");
    }
  });

  bot.action(AUTOPILOT_LIVE_EXECUTE_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Broadcasting transaction...");
      await ctx.reply("Sending atomic rebalance transaction to Base. Please wait...");

      await replyWithLiveExecutionResult(ctx, planId);
    } catch (error) {
      await ctx.answerCbQuery("Live execution failed", { show_alert: true });
      await ctx.reply(telegramSafeMessage(error instanceof Error ? `Live execution failed: ${error.message}` : "Live execution failed."));
    }
  });

  bot.action(AUTOPILOT_LIVE_EXECUTE_DEBT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Broadcasting accepted-debt transaction...");
      await ctx.reply("Sending accepted-debt atomic rebalance transaction to Base. Please wait...");

      await replyWithLiveExecutionResult(ctx, planId, { allowUncoveredDebt: true });
    } catch (error) {
      await ctx.answerCbQuery("Live execution failed", { show_alert: true });
      await ctx.reply(telegramSafeMessage(error instanceof Error ? `Live execution failed: ${error.message}` : "Live execution failed."));
    }
  });

  bot.action(AUTOPILOT_LIVE_EXECUTE_DRIFT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Broadcasting accepted-drift transaction...");
      await ctx.reply("Sending accepted-drift atomic rebalance transaction to Base. Please wait...");

      await replyWithLiveExecutionResult(ctx, planId, { allowBoundaryDrift: true });
    } catch (error) {
      await ctx.answerCbQuery("Live execution failed", { show_alert: true });
      await ctx.reply(telegramSafeMessage(error instanceof Error ? `Live execution failed: ${error.message}` : "Live execution failed."));
    }
  });

  bot.action(AUTOPILOT_LIVE_EXECUTE_DEBT_DRIFT_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Broadcasting accepted-risk transaction...");
      await ctx.reply("Sending accepted-risk atomic rebalance transaction to Base. Please wait...");

      await replyWithLiveExecutionResult(ctx, planId, { allowUncoveredDebt: true, allowBoundaryDrift: true });
    } catch (error) {
      await ctx.answerCbQuery("Live execution failed", { show_alert: true });
      await ctx.reply(telegramSafeMessage(error instanceof Error ? `Live execution failed: ${error.message}` : "Live execution failed."));
    }
  });

  return bot;
}
