import { PositionStatus } from "@prisma/client";
import { Telegraf } from "telegraf";
import { getConfig } from "./config";
import { prisma } from "./db";
import { shortAddress } from "./format";

export function isOutOfRange(status: PositionStatus) {
  return status === PositionStatus.above_range || status === PositionStatus.below_range;
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

  for (const position of positions) {
    if (isOutOfRange(position.lastAlertStatus ?? PositionStatus.unknown)) continue;

    const dedupeKey = `out-of-range:${position.id}:${position.status}:${position.currentTick ?? "na"}`;
    const existing = await prisma.telegramEvent.findUnique({ where: { dedupeKey } });
    if (existing) continue;

    const direction = position.status === PositionStatus.above_range ? "above range" : "below range";
    await bot.telegram.sendMessage(
      TELEGRAM_CHAT_ID,
      [
        `Uniswap v3 WETH/USDC position #${position.tokenId} is ${direction}.`,
        `Wallet: ${shortAddress(position.wallet.address)}`,
        `Tick: ${position.currentTick ?? "unknown"} | Range: ${position.tickLower} - ${position.tickUpper}`,
        position.poolAddress ? `Pool: ${shortAddress(position.poolAddress)}` : undefined
      ]
        .filter(Boolean)
        .join("\n")
    );

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

  return { sent };
}
