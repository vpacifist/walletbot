import { PositionStatus } from "@prisma/client";
import { Telegraf } from "telegraf";
import { getAddress } from "viem";
import { getConfig } from "./config";
import { prisma } from "./db";
import { formatNumber, shortAddress } from "./format";
import { getWalletAssetSnapshot } from "./wallet-assets";

const LOW_NATIVE_ETH_THRESHOLD_USD = 10;

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
