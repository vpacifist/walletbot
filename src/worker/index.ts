import { sendAutopilotPlanAlert, sendLowNativeEthAlert, sendOutOfRangeAlerts } from "@/lib/alerts";
import { startAutopilotPriceWatch } from "@/lib/autopilot-price-watch";
import { sendTopUpAlert } from "@/lib/autopilot-top-up";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { refreshTrackedPositionsForWallet } from "@/lib/positions";
import { syncWalletOnce } from "@/lib/sync";
import { createBot } from "./bot";

function msUntilNextMoscowTen(now = new Date()) {
  const next = new Date(now);
  next.setUTCHours(7, 0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.getTime() - now.getTime();
}

async function main() {
  const config = getConfig();
  const bot = createBot();
  let lowEthCheckTimeout: ReturnType<typeof setTimeout> | undefined;
  let topUpCheckTimeout: ReturnType<typeof setTimeout> | undefined;
  let priceWatchInterval: ReturnType<typeof setInterval> | null = null;

  if (bot) {
    await bot.telegram
      .setMyCommands([
        { command: "autopilot", description: "Show current autopilot plan" },
        { command: "autopilot_retry", description: "Retry current autopilot incident" },
        { command: "autopilot_pause", description: "Pause auto-guarded execution" },
        { command: "autopilot_resume", description: "Resume auto-guarded execution" },
        { command: "topup", description: "Review unused WETH/USDC top-up" },
        { command: "status", description: "Show wallet sync and position status" },
        { command: "positions", description: "Show latest WETH/USDC positions" },
        { command: "web", description: "Open WalletBot web dashboard" }
      ])
      .then(() => console.log("Telegram bot commands registered"))
      .catch((error) => console.error("Telegram bot command registration failed", error));

    void bot
      .launch()
      .then(() => console.log("Telegram bot launched"))
      .catch((error) => console.error("Telegram bot failed to launch", error));
  } else {
    console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN is empty");
  }

  const runLowEthCheck = async () => {
    try {
      if (bot) {
        const result = await sendLowNativeEthAlert(bot);
        console.log("low native ETH check complete", result);
      }
    } catch (error) {
      console.error("low native ETH check failed", error);
    } finally {
      lowEthCheckTimeout = setTimeout(runLowEthCheck, msUntilNextMoscowTen());
    }
  };

  const runTopUpCheck = async () => {
    try {
      if (bot) {
        const result = await sendTopUpAlert(bot);
        console.log("top-up check complete", result);
      }
    } catch (error) {
      console.error("top-up check failed", error);
    } finally {
      topUpCheckTimeout = setTimeout(runTopUpCheck, msUntilNextMoscowTen());
    }
  };

  const run = async () => {
    try {
      const refreshedPositions = await refreshTrackedPositionsForWallet().catch((error) => {
        console.error("RPC position refresh failed", error);
        return [];
      });
      const result = await syncWalletOnce();
      if (bot) {
        const autopilotAlert = await sendAutopilotPlanAlert(bot);
        const rangeAlerts = await sendOutOfRangeAlerts(bot);
        console.log("alert checks complete", { autopilotAlert, rangeAlerts });
      }
      console.log("sync complete", { ...result, rpcPositionsRefreshed: refreshedPositions.length });
    } catch (error) {
      console.error("sync failed", error);
    }
  };

  const interval = setInterval(run, config.SYNC_INTERVAL_SECONDS * 1000);
  if (bot) {
    priceWatchInterval = startAutopilotPriceWatch(bot);
    if (priceWatchInterval) {
      console.log(`autopilot fast price watch enabled: ${config.AUTOPILOT_PRICE_WATCH_INTERVAL_MS}ms`);
    }
    lowEthCheckTimeout = setTimeout(runLowEthCheck, msUntilNextMoscowTen());
    topUpCheckTimeout = setTimeout(runTopUpCheck, msUntilNextMoscowTen());
  }
  void run();

  const shutdown = async () => {
    clearInterval(interval);
    if (priceWatchInterval) clearInterval(priceWatchInterval);
    if (lowEthCheckTimeout) clearTimeout(lowEthCheckTimeout);
    if (topUpCheckTimeout) clearTimeout(topUpCheckTimeout);
    bot?.stop("SIGTERM");
    await prisma.$disconnect();
    process.exit(0);
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
