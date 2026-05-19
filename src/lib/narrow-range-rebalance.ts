import { type Address } from "viem";
import { factoryAbi, poolAbi } from "./abi";
import { createBaseClient } from "./chain";
import { CONTRACTS, TOKEN_META } from "./constants";
import { getWalletAssetAmountsSnapshot } from "./wallet-assets";

const WETH_USDC_NARROW_FEE = 3000;
const WETH_USDC_NARROW_TICK_SPACING = 60;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

export type NarrowRangeRebalance = {
  wallet: {
    weth: number | null;
    usdc: number | null;
  };
  pool: {
    address: Address;
    fee: number;
    tickSpacing: number;
    currentTick: number;
    lowerTick: number;
    upperTick: number;
    price: number;
    lowerPrice: number;
    upperPrice: number;
    widthPercent: number;
  };
  target: {
    weth: number;
    usdc: number;
    wethValueUsd: number;
    usdcValueUsd: number;
    totalValueUsd: number;
    usdcPerWethRatio: number;
  };
  swap: {
    direction: "weth_to_usdc" | "usdc_to_weth" | "none" | "unavailable";
    spendSymbol: "WETH" | "USDC" | null;
    spendAmount: number | null;
    receiveSymbol: "WETH" | "USDC" | null;
    idealReceiveAmount: number | null;
    reason: string | null;
  };
  updatedAt: string;
};

function priceFromTick(params: { tick: number; token0: Address; token1: Address; baseToken: Address; quoteToken: Address }) {
  const token0Meta = TOKEN_META[params.token0.toLowerCase()];
  const token1Meta = TOKEN_META[params.token1.toLowerCase()];
  if (!token0Meta || !token1Meta) return null;

  const token1PerToken0 = Math.pow(1.0001, params.tick) * 10 ** (token0Meta.decimals - token1Meta.decimals);
  const token0 = params.token0.toLowerCase();
  const token1 = params.token1.toLowerCase();
  const base = params.baseToken.toLowerCase();
  const quote = params.quoteToken.toLowerCase();

  if (token0 === base && token1 === quote) return token1PerToken0;
  if (token0 === quote && token1 === base) return 1 / token1PerToken0;
  return null;
}

function narrowTicksAround(currentTick: number) {
  const nearestLowerTick = Math.floor(currentTick / WETH_USDC_NARROW_TICK_SPACING) * WETH_USDC_NARROW_TICK_SPACING;
  const lowerTick = nearestLowerTick - WETH_USDC_NARROW_TICK_SPACING;
  return {
    lowerTick,
    upperTick: nearestLowerTick + WETH_USDC_NARROW_TICK_SPACING
  };
}

export function calculateNarrowRangeRebalance(params: {
  weth: number | null;
  usdc: number | null;
  price: number | null;
  lowerPrice: number | null;
  upperPrice: number | null;
}) {
  const { weth, usdc, price, lowerPrice, upperPrice } = params;
  if (weth === null || usdc === null || price === null || lowerPrice === null || upperPrice === null) {
    return {
      target: null,
      swap: {
        direction: "unavailable" as const,
        spendSymbol: null,
        spendAmount: null,
        receiveSymbol: null,
        idealReceiveAmount: null,
        reason: "Missing wallet balances or pool price"
      }
    };
  }

  if (weth < 0 || usdc < 0 || price <= 0 || lowerPrice <= 0 || upperPrice <= price || lowerPrice >= price) {
    return {
      target: null,
      swap: {
        direction: "unavailable" as const,
        spendSymbol: null,
        spendAmount: null,
        receiveSymbol: null,
        idealReceiveAmount: null,
        reason: "Invalid wallet balances or target range"
      }
    };
  }

  const sqrtPrice = Math.sqrt(price);
  const sqrtLower = Math.sqrt(lowerPrice);
  const sqrtUpper = Math.sqrt(upperPrice);
  const usdcPerWethRatio = (sqrtPrice * sqrtUpper * (sqrtPrice - sqrtLower)) / (sqrtUpper - sqrtPrice);
  const totalValueUsd = weth * price + usdc;
  const targetWeth = totalValueUsd / (price + usdcPerWethRatio);
  const targetUsdc = totalValueUsd - targetWeth * price;
  const wethDelta = targetWeth - weth;
  const usdcDelta = targetUsdc - usdc;
  const dustThresholdUsd = Math.max(totalValueUsd * 0.000001, 0.000001);

  if (Math.abs(wethDelta * price) <= dustThresholdUsd && Math.abs(usdcDelta) <= dustThresholdUsd) {
    return {
      target: {
        weth: targetWeth,
        usdc: targetUsdc,
        wethValueUsd: targetWeth * price,
        usdcValueUsd: targetUsdc,
        totalValueUsd,
        usdcPerWethRatio
      },
      swap: {
        direction: "none" as const,
        spendSymbol: null,
        spendAmount: 0,
        receiveSymbol: null,
        idealReceiveAmount: 0,
        reason: null
      }
    };
  }

  return {
    target: {
      weth: targetWeth,
      usdc: targetUsdc,
      wethValueUsd: targetWeth * price,
      usdcValueUsd: targetUsdc,
      totalValueUsd,
      usdcPerWethRatio
    },
    swap:
      wethDelta < 0
        ? {
            direction: "weth_to_usdc" as const,
            spendSymbol: "WETH" as const,
            spendAmount: -wethDelta,
            receiveSymbol: "USDC" as const,
            idealReceiveAmount: usdcDelta,
            reason: null
          }
        : {
            direction: "usdc_to_weth" as const,
            spendSymbol: "USDC" as const,
            spendAmount: -usdcDelta,
            receiveSymbol: "WETH" as const,
            idealReceiveAmount: wethDelta,
            reason: null
          }
  };
}

export async function getNarrowRangeRebalance(walletAddress: Address): Promise<NarrowRangeRebalance> {
  const client = createBaseClient();
  const [wallet, poolAddress] = await Promise.all([
    getWalletAssetAmountsSnapshot(walletAddress),
    client.readContract({
      address: CONTRACTS.uniswapV3Factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [CONTRACTS.weth, CONTRACTS.usdc, WETH_USDC_NARROW_FEE]
    })
  ]);

  if (poolAddress === ZERO_ADDRESS) throw new Error("WETH/USDC 0.3% pool not found");

  const [slot0, token0, token1] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token1" })
  ]);

  const currentTick = Number(slot0[1]);
  const { lowerTick, upperTick } = narrowTicksAround(currentTick);
  const price = priceFromTick({ tick: currentTick, token0, token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
  const lowerPrice = priceFromTick({ tick: lowerTick, token0, token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
  const upperPrice = priceFromTick({ tick: upperTick, token0, token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
  const calculation = calculateNarrowRangeRebalance({ weth: wallet.weth, usdc: wallet.usdc, price, lowerPrice, upperPrice });

  return {
    wallet: {
      weth: wallet.weth,
      usdc: wallet.usdc
    },
    pool: {
      address: poolAddress,
      fee: WETH_USDC_NARROW_FEE,
      tickSpacing: WETH_USDC_NARROW_TICK_SPACING,
      currentTick,
      lowerTick,
      upperTick,
      price: price ?? 0,
      lowerPrice: lowerPrice ?? 0,
      upperPrice: upperPrice ?? 0,
      widthPercent: lowerPrice && upperPrice ? (upperPrice / lowerPrice - 1) * 100 : 0
    },
    target:
      calculation.target ?? {
        weth: 0,
        usdc: 0,
        wethValueUsd: 0,
        usdcValueUsd: 0,
        totalValueUsd: 0,
        usdcPerWethRatio: 0
      },
    swap: calculation.swap,
    updatedAt: new Date().toISOString()
  };
}
