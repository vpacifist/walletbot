import { Context, Telegraf } from "telegraf";
import { broadcastAutopilotRebalance } from "@/lib/autopilot-broadcaster";
import { createAutopilotDryRunExecution } from "@/lib/autopilot-executor";
import { createAutopilotExecutionPreview } from "@/lib/autopilot-execution-preview";
import { getOrCreatePendingAutopilotPlan, recordAutopilotPlanDecision } from "@/lib/autopilot-service";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { shortAddress } from "@/lib/format";
import { getWebAppUrl } from "@/lib/web-app-url";

const AUTOPILOT_DECISION_PATTERN = /^ap:(approve|skip|pause):(.+)$/;
const AUTOPILOT_EXECUTE_PATTERN = /^ap:execute:(.+)$/;
const AUTOPILOT_ACCEPT_DEBT_PATTERN = /^ap:accept_debt:(.+)$/;
const AUTOPILOT_LIVE_REVIEW_PATTERN = /^ap:live_review:(.+)$/;
const AUTOPILOT_LIVE_EXECUTE_PATTERN = /^ap:execute_live:(.+)$/;
const AUTOPILOT_LIVE_EXECUTE_DEBT_PATTERN = /^ap:execute_live_debt:(.+)$/;

function telegramSafeMessage(message: string, maxLength = 3_800) {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 80)}\n\n[message truncated; see Railway logs or plan history for full details]`;
}

function assertAllowedChat(ctx: Context) {
  const expected = getConfig().TELEGRAM_CHAT_ID;
  if (!expected) return true;
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

function autopilotLiveConfirmKeyboard(planId: string, options: { allowUncoveredDebt?: boolean } = {}) {
  return {
    inline_keyboard: [
      [
        {
          text: options.allowUncoveredDebt ? "Confirm accepted-debt transaction" : "Confirm live transaction",
          callback_data: `${options.allowUncoveredDebt ? "ap:execute_live_debt" : "ap:execute_live"}:${planId}`
        },
        { text: "Cancel", callback_data: `ap:pause:${planId}` }
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

function uncoveredDebtText(execution: { checks: Array<{ label: string; detail: string }> }) {
  return execution.checks.find((check) => check.label === "Uncovered debt")?.detail;
}

function liveReviewMessage(planId: string, execution: Awaited<ReturnType<typeof createAutopilotDryRunExecution>>, options: { allowUncoveredDebt?: boolean } = {}) {
  return [
    "Live execution review",
    `Plan id: ${planId}`,
    "",
    options.allowUncoveredDebt ? `You are accepting uncovered debt: ${uncoveredDebtText(execution) ?? "above normal limit"}` : undefined,
    options.allowUncoveredDebt ? "This may lock in a worse buyback/sell price." : undefined,
    options.allowUncoveredDebt ? "" : undefined,
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

export function createBot() {
  const { TELEGRAM_BOT_TOKEN } = getConfig();
  if (!TELEGRAM_BOT_TOKEN) return null;

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => {
    if (!assertAllowedChat(ctx)) return;
    return ctx.reply("WalletBot is running. Use /status, /positions, /autopilot, or /web.");
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
        await ctx.reply(preview.telegramSummary, {
          reply_markup: preview.status === "ready" ? autopilotExecutionKeyboard(record.id) : blockedOnlyByUncoveredDebt(preview) ? autopilotAcceptDebtKeyboard(record.id) : undefined
        });
      }
    } catch (error) {
      await ctx.answerCbQuery("Plan update failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Autopilot plan update failed: ${error.message}` : "Autopilot plan update failed.");
    }
  });

  bot.action(AUTOPILOT_EXECUTE_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Executor dry-run started");
      const execution = await createAutopilotDryRunExecution(planId);
      const liveKeyboard = execution.status === "validated" ? autopilotLiveKeyboard(planId) : undefined;
      await ctx.reply(execution.telegramSummary, {
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

  bot.action(AUTOPILOT_LIVE_REVIEW_PATTERN, async (ctx) => {
    if (!assertAllowedChat(ctx)) return;

    const planId = ctx.match[1];

    try {
      await ctx.answerCbQuery("Preparing live review...");
      const execution = await createAutopilotDryRunExecution(planId);

      if (execution.status !== "validated") {
        await ctx.reply(["Live execution review blocked.", "", execution.telegramSummary].join("\n"));
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

      const result = await broadcastAutopilotRebalance(planId);

      if (result.success && result.txHash) {
        const explorerUrl = `${getConfig().BLOCKSCOUT_BASE_URL}/tx/${result.txHash}`;
        await ctx.reply(
          [
            "**Transaction executed successfully on-chain!**",
            `Tx Hash: \`${result.txHash}\``,
            `[View on Blockscout](${explorerUrl})`
          ].join("\n"),
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(telegramSafeMessage(`**On-chain execution failed:**\n${result.error || "Unknown error"}`));
      }
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

      const result = await broadcastAutopilotRebalance(planId, { allowUncoveredDebt: true });

      if (result.success && result.txHash) {
        const explorerUrl = `${getConfig().BLOCKSCOUT_BASE_URL}/tx/${result.txHash}`;
        await ctx.reply(
          [
            "**Transaction executed successfully on-chain!**",
            `Tx Hash: \`${result.txHash}\``,
            `[View on Blockscout](${explorerUrl})`
          ].join("\n"),
          { parse_mode: "Markdown" }
        );
      } else {
        await ctx.reply(telegramSafeMessage(`**On-chain execution failed:**\n${result.error || "Unknown error"}`));
      }
    } catch (error) {
      await ctx.answerCbQuery("Live execution failed", { show_alert: true });
      await ctx.reply(telegramSafeMessage(error instanceof Error ? `Live execution failed: ${error.message}` : "Live execution failed."));
    }
  });

  return bot;
}
