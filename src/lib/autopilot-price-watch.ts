import { PositionStatus } from "@/generated/prisma/client";
import { type Telegraf } from "telegraf";
import { getAddress } from "viem";
import { factoryAbi, poolAbi } from "./abi";
import { autopilotBreakoutDepthTicks, autopilotBreakoutSide } from "./autopilot-breakout";
import { sendTopUpOpportunityAlert } from "./autopilot-top-up";
import { sendAutopilotPlanAlert } from "./alerts";
import { baseRpcUrlsWithPublicFallback, createBaseClient, createBaseClientForUrl } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS } from "./constants";
import { prisma } from "./db";
import { WETH_USDC_NARROW_FEE } from "./narrow-range-rebalance";

type ActiveRange = {
  id: string;
  tokenId: string;
  lowerTick: number;
  upperTick: number;
};

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

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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

async function readPoolTickWithClient(client: ReturnType<typeof createBaseClient>) {
  const poolAddress = await client.readContract({
    address: CONTRACTS.uniswapV3Factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [CONTRACTS.weth, CONTRACTS.usdc, WETH_USDC_NARROW_FEE]
  });
  if (poolAddress === ZERO_ADDRESS) throw new Error("WETH/USDC 0.3% pool not found");

  const slot0 = await client.readContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: "slot0"
  });
  return Number(slot0[1]);
}

export async function readWethUsdcPoolTick() {
  const client = createBaseClient();
  try {
    return await readPoolTickWithClient(client);
  } catch (primaryError) {
    let lastError = primaryError;
    for (const url of baseRpcUrlsWithPublicFallback()) {
      try {
        return await readPoolTickWithClient(createBaseClientForUrl(url));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
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
  if (state.lastTriggerKey === triggerKey) return { triggered: false, skipped: "duplicate_fast_trigger", tick, tokenId: range.tokenId, side, depthTicks };

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
