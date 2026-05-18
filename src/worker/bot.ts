import { Context, Telegraf } from "telegraf";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { shortAddress } from "@/lib/format";

function assertAllowedChat(ctx: Context) {
  const expected = getConfig().TELEGRAM_CHAT_ID;
  if (!expected) return true;
  return String(ctx.chat?.id) === expected;
}

export function createBot() {
  const { TELEGRAM_BOT_TOKEN } = getConfig();
  if (!TELEGRAM_BOT_TOKEN) return null;

  const bot = new Telegraf(TELEGRAM_BOT_TOKEN);

  bot.start((ctx) => {
    if (!assertAllowedChat(ctx)) return;
    return ctx.reply("WalletBot is running. Use /status or /positions.");
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

  return bot;
}
