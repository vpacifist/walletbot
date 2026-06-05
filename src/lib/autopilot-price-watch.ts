import { PositionStatus } from "@/generated/prisma/client";
import { type Telegraf } from "telegraf";
import { getAddress } from "viem";
import { poolAbi } from "./abi";
import { sendAutopilotPlanAlert } from "./alerts";
import { createBaseClient } from "./chain";
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
  lastTriggerKey: string | null;
};

const state: PriceWatchState = {
  running: false,
  lastTriggerKey: null
};

export async function readWethUsdcPoolTick() {
  const client = createBaseClient();
  const slot0 = await client.readContract({
    address: CONTRACTS.wethUsdcUniswapV3Pool,
    abi: poolAbi,
    functionName: "slot0"
  });
  return Number(slot0[1]);
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

function triggerSide(tick: number, range: ActiveRange) {
  if (tick < range.lowerTick) return "below";
  if (tick >= range.upperTick) return "above";
  return null;
}

export async function checkAutopilotPriceBoundary(bot: Telegraf) {
  const config = getConfig();
  if (config.AUTOPILOT_MODE !== "auto_guarded") return { triggered: false, skipped: "mode_not_auto_guarded" };
  if (!config.TELEGRAM_CHAT_ID) return { triggered: false, skipped: "telegram_not_configured" };
  if (state.running) return { triggered: false, skipped: "already_running" };

  const [range, tick] = await Promise.all([getActiveAutopilotRange(), readWethUsdcPoolTick()]);
  if (!range) return { triggered: false, skipped: "active_range_not_found", tick };

  const side = triggerSide(tick, range);
  if (!side) {
    state.lastTriggerKey = null;
    return { triggered: false, skipped: "inside_range", tick, tokenId: range.tokenId };
  }

  const triggerKey = `${range.tokenId}:${range.lowerTick}:${range.upperTick}:${side}`;
  if (state.lastTriggerKey === triggerKey) return { triggered: false, skipped: "duplicate_fast_trigger", tick, tokenId: range.tokenId, side };

  state.running = true;
  state.lastTriggerKey = triggerKey;
  try {
    await bot.telegram.sendMessage(
      config.TELEGRAM_CHAT_ID,
      [`Fast price trigger: ${side} boundary crossed`, `Position #${range.tokenId}`, `Tick ${tick} | Range ${range.lowerTick} - ${range.upperTick}`].join("\n")
    );
    const result = await sendAutopilotPlanAlert(bot);
    return { triggered: true, tick, tokenId: range.tokenId, side, result };
  } finally {
    state.running = false;
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
      .catch((error) => console.error("autopilot price watch failed", error));
  }, intervalMs);

  return interval;
}

export function resetAutopilotPriceWatchStateForTest() {
  state.running = false;
  state.lastTriggerKey = null;
}
