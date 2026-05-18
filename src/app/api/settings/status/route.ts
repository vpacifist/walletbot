import { NextResponse } from "next/server";
import { isAuthenticated } from "@/lib/auth";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const config = getConfig();
  const wallet = await prisma.wallet.findUnique({ where: { address: config.BASE_WALLET_ADDRESS } });
  const latestRun = await prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } });

  return NextResponse.json({
    walletAddress: config.BASE_WALLET_ADDRESS,
    blockscoutBaseUrl: config.BLOCKSCOUT_BASE_URL,
    telegramEnabled: Boolean(config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID),
    lastSyncedBlock: wallet?.lastSyncedBlock?.toString() ?? null,
    latestRun: latestRun
      ? {
          ...latestRun,
          fromBlock: latestRun.fromBlock?.toString() ?? null,
          toBlock: latestRun.toBlock?.toString() ?? null
        }
      : null
  });
}
