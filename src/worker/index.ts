import { sendOutOfRangeAlerts } from "@/lib/alerts";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { syncWalletOnce } from "@/lib/sync";
import { createBot } from "./bot";

async function main() {
  const config = getConfig();
  const bot = createBot();

  if (bot) {
    void bot
      .launch()
      .then(() => console.log("Telegram bot launched"))
      .catch((error) => console.error("Telegram bot failed to launch", error));
  } else {
    console.log("Telegram bot disabled: TELEGRAM_BOT_TOKEN is empty");
  }

  const run = async () => {
    try {
      const result = await syncWalletOnce();
      if (bot) await sendOutOfRangeAlerts(bot);
      console.log("sync complete", result);
    } catch (error) {
      console.error("sync failed", error);
    }
  };

  await run();
  const interval = setInterval(run, config.SYNC_INTERVAL_SECONDS * 1000);

  const shutdown = async () => {
    clearInterval(interval);
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
