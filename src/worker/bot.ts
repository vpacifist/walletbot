import { Context, Telegraf } from "telegraf";
import { getOrCreatePendingAutopilotPlan, recordAutopilotPlanDecision } from "@/lib/autopilot-service";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { shortAddress } from "@/lib/format";

const AUTOPILOT_ACTION_PATTERN = /^ap:(approve|skip|pause):(.+)$/;

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

function decisionLabel(decision: string) {
  if (decision === "approved") return "Approved";
  if (decision === "skipped") return "Skipped";
  if (decision === "paused") return "Paused";
  return decision;
}

export function createBot() {
  const { TELEGRAM_BOT_TOKEN } = getConfig();
  if (!TELEGRAM_BOT_TOKEN) return null;

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => {
    if (!assertAllowedChat(ctx)) return;
    return ctx.reply("WalletBot is running. Use /status, /positions, or /autopilot.");
  });

  bot.command("status", async (ctx) => {
    if (!assertAllowedChat(ctx)) return;
    const wallet = await prisma.wallet.findFirst({ where: { enabled: true }, include: { positions: true } });
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
    const positions = await prisma.position.findMany({ orderBy: { updatedAt: "desc" }, take: 10 });
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

  bot.action(AUTOPILOT_ACTION_PATTERN, async (ctx) => {
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
          record.status === "approved" ? "Execution is not enabled yet. This only records approval for the next executor step." : undefined
        ]
          .filter(Boolean)
          .join("\n")
      );
    } catch (error) {
      await ctx.answerCbQuery("Plan update failed", { show_alert: true });
      await ctx.reply(error instanceof Error ? `Autopilot plan update failed: ${error.message}` : "Autopilot plan update failed.");
    }
  });

  return bot;
}
