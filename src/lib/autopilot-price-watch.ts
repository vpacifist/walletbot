import { PositionStatus } from "@/generated/prisma/client";
import { type Telegraf } from "telegraf";
import { getAddress } from "viem";
import { positionManagerAbi } from "./abi";
import { autopilotBreakoutDepthTicks, autopilotBreakoutSide } from "./autopilot-breakout";
import { sendTopUpOpportunityAlert } from "./autopilot-top-up";
import { sendAutopilotPlanAlert } from "./alerts";
import { baseRpcUrlsWithPublicFallback, createBaseClient, createBaseClientForUrl } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS } from "./constants";
import { prisma } from "./db";
import { WETH_USDC_NARROW_FEE } from "./narrow-range-rebalance";
import { refreshTrackedPositionsForWallet } from "./positions";
import { readWethUsdcPoolTick } from "./weth-usdc-pool";

type ActiveRange = {
  id: string;
  tokenId: string;
  lowerTick: number;
  upperTick: number;
};

const SUSTAINED_BREAKOUT_WAIT_MS = 15 * 60 * 1000;

type PriceWatchState = {
  running: boolean;
  topUpRunning: boolean;
  lastTriggerKey: string | null;
  lastTopUpCheckAt: number;
};

const state: PriceWatchState = {
  running: false,
  topUpRunning: false,
  lastTriggerKey: null,
  lastTopUpCheckAt: 0
};

function redactSensitiveRpcText(message: string) {
  return message
    .replace(/https:\/\/base-mainnet\.g\.alchemy\.com\/v2\/[A-Za-z0-9_-]+/g, "https://base-mainnet.g.alchemy.com/v2/[redacted]")
    .replace(/https:\/\/[^/\s]+\/v2\/[A-Za-z0-9_-]+/g, "https://[rpc-redacted]/v2/[redacted]");
}

function shortError(error: unknown) {
  const message = redactSensitiveRpcText(error instanceof Error ? error.message : String(error));
  if (message.length <= 240) return message;
  return `${message.slice(0, 237)}...`;
}

export async function getActiveAutopilotRange(): Promise<ActiveRange | null> {
  const walletAddress = getAddress(getConfig().BASE_WALLET_ADDRESS);
  const wallet = await prisma.wallet.findUnique({ where: { address: walletAddress } });
  if (!wallet) return null;

  const position = await prisma.position.findFirst({
    where: {
      walletId: wallet.id,
      fee: WETH_USDC_NARROW_FEE,
      status: { not: PositionStatus.closed_or_zero_liquidity }
    },
    orderBy: [{ tokenId: "desc" }, { updatedAt: "desc" }]
  });
  if (!position) return null;

  return {
    id: position.id,
    tokenId: position.tokenId,
    lowerTick: position.tickLower,
    upperTick: position.tickUpper
  };
}

async function rangeHasLiveLiquidity(tokenId: string) {
  const read = (client: ReturnType<typeof createBaseClient>) =>
    client.readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [BigInt(tokenId)]
    });

  let position;
  try {
    position = await read(createBaseClient());
  } catch (primaryError) {
    let lastError = primaryError;
    for (const url of baseRpcUrlsWithPublicFallback()) {
      try {
        position = await read(createBaseClientForUrl(url));
        break;
      } catch (error) {
        lastError = error;
      }
    }
    if (!position) throw lastError;
  }

  return position[7] > 0n;
}

async function sustainedWaitExpired(range: ActiveRange, side: "above" | "below") {
  const direction = side === "above" ? "above_range" : "below_range";
  const existing = await prisma.telegramEvent.findFirst({
    where: {
      alertType: "autopilot_sustained_wait",
      dedupeKey: {
        contains: `:${range.tokenId}:${range.lowerTick}:${range.upperTick}:${direction}`
      }
    },
    orderBy: { sentAt: "desc" }
  });

  return Boolean(existing && Date.now() - existing.sentAt.getTime() >= SUSTAINED_BREAKOUT_WAIT_MS);
}

export async function checkAutopilotPriceBoundary(bot: Telegraf) {
  const config = getConfig();
  if (config.AUTOPILOT_MODE !== "auto_guarded") return { triggered: false, skipped: "mode_not_auto_guarded" };
  if (!config.TELEGRAM_CHAT_ID) return { triggered: false, skipped: "telegram_not_configured" };
  if (state.running) return { triggered: false, skipped: "already_running" };

  const [range, tick] = await Promise.all([getActiveAutopilotRange(), readWethUsdcPoolTick()]);
  if (!range) return { triggered: false, skipped: "active_range_not_found", tick };

  const side = autopilotBreakoutSide(tick, range);
  if (!side) {
    state.lastTriggerKey = null;
    await maybeCheckTopUpOpportunity(bot, tick);
    return { triggered: false, skipped: "inside_range", tick, tokenId: range.tokenId };
  }
  const depthTicks = autopilotBreakoutDepthTicks(tick, range);
  if (depthTicks < config.AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS) {
    return { triggered: false, skipped: "micro_breakout", tick, tokenId: range.tokenId, side, depthTicks };
  }

  const triggerKey = `${range.tokenId}:${range.lowerTick}:${range.upperTick}:${side}`;
  if (state.lastTriggerKey === triggerKey && !(await sustainedWaitExpired(range, side))) {
    return { triggered: false, skipped: "duplicate_fast_trigger", tick, tokenId: range.tokenId, side, depthTicks };
  }

  let hasLiveLiquidity = false;
  try {
    hasLiveLiquidity = await rangeHasLiveLiquidity(range.tokenId);
  } catch (error) {
    state.lastTriggerKey = triggerKey;
    console.error("autopilot live liquidity check failed", shortError(error));
    return { triggered: false, skipped: "live_liquidity_check_failed", tick, tokenId: range.tokenId, side, depthTicks };
  }

  if (!hasLiveLiquidity) {
    state.lastTriggerKey = triggerKey;
    await prisma.position.update({
      where: { id: range.id },
      data: {
        liquidity: "0",
        status: PositionStatus.closed_or_zero_liquidity,
        lastCheckedAt: new Date()
      }
    });
    await refreshTrackedPositionsForWallet([range.tokenId]);
    return { triggered: false, skipped: "stale_closed_position", tick, tokenId: range.tokenId, side, depthTicks };
  }

  state.running = true;
  state.lastTriggerKey = triggerKey;
  try {
    const result = await sendAutopilotPlanAlert(bot);
    if ("autoGuarded" in result && result.autoGuarded === "failed") {
      state.lastTriggerKey = null;
    }
    if ("skipped" in result && result.skipped === "duplicate_plan_key") {
      await bot.telegram.sendMessage(
        config.TELEGRAM_CHAT_ID,
        [
          "Auto-guarded retry is waiting for your confirmation",
          "This crossing was already seen before the latest fix/deploy, so the old duplicate guard blocked an automatic restart.",
          "",
          "Use this only when the previous auto-rebalance attempt failed and you want to restart the current incident."
        ].join("\n"),
        {
          reply_markup: {
            inline_keyboard: [[{ text: "Retry current incident", callback_data: "ap:retry_current" }]]
          }
        }
      );
    }
    return { triggered: true, tick, tokenId: range.tokenId, side, depthTicks, result };
  } finally {
    state.running = false;
  }
}

async function maybeCheckTopUpOpportunity(bot: Telegraf, tick: number) {
  const config = getConfig();
  if (!config.AUTOPILOT_TOP_UP_ENABLED) return { sent: 0, skipped: "top_up_disabled" };
  if (config.AUTOPILOT_TOP_UP_WATCH_INTERVAL_MS <= 0) return { sent: 0, skipped: "top_up_watch_disabled" };
  if (state.topUpRunning) return { sent: 0, skipped: "top_up_already_running" };

  const now = Date.now();
  if (now - state.lastTopUpCheckAt < config.AUTOPILOT_TOP_UP_WATCH_INTERVAL_MS) {
    return { sent: 0, skipped: "top_up_watch_throttled" };
  }

  state.topUpRunning = true;
  state.lastTopUpCheckAt = now;
  try {
    const result = await sendTopUpOpportunityAlert(bot, tick);
    if (result.sent) {
      console.log("top-up opportunity watch", result);
    }
    return result;
  } finally {
    state.topUpRunning = false;
  }
}

export function startAutopilotPriceWatch(bot: Telegraf) {
  const intervalMs = getConfig().AUTOPILOT_PRICE_WATCH_INTERVAL_MS;
  if (intervalMs <= 0) return null;

  const interval = setInterval(() => {
    void checkAutopilotPriceBoundary(bot)
      .then((result) => {
        if (result.triggered || result.skipped !== "inside_range") {
          console.log("autopilot price watch", result);
        }
      })
      .catch((error) => console.error("autopilot price watch failed", shortError(error)));
  }, intervalMs);

  return interval;
}

export function resetAutopilotPriceWatchStateForTest() {
  state.running = false;
  state.topUpRunning = false;
  state.lastTriggerKey = null;
  state.lastTopUpCheckAt = 0;
}
