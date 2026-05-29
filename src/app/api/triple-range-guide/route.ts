import { NextResponse } from "next/server";
import { type Position } from "@prisma/client";
import { getAddress } from "viem";
import { factoryAbi, poolAbi } from "@/lib/abi";
import { isAuthenticated } from "@/lib/auth";
import { createBaseClient } from "@/lib/chain";
import { getConfig } from "@/lib/config";
import { CONTRACTS } from "@/lib/constants";
import { prisma } from "@/lib/db";
import { priceFromTick, WETH_USDC_NARROW_FEE } from "@/lib/narrow-range-rebalance";
import { calculateTripleRangeGuide } from "@/lib/triple-range-guide";
import { getWalletAssetAmountsSnapshot } from "@/lib/wallet-assets";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function activeNarrowPosition(position: Position) {
  return position.fee === WETH_USDC_NARROW_FEE && position.status !== "closed_or_zero_liquidity" && position.currentTick !== null;
}

function latestSyncedPoolSnapshot(positions: Position[]) {
  const reference = positions
    .filter(activeNarrowPosition)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];

  if (!reference || reference.currentTick === null) return null;

  return {
    currentTick: reference.currentTick,
    token0: getAddress(reference.token0),
    token1: getAddress(reference.token1)
  };
}

async function livePoolSnapshot() {
  const client = createBaseClient();
  const poolAddress = await client.readContract({
    address: CONTRACTS.uniswapV3Factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [CONTRACTS.weth, CONTRACTS.usdc, WETH_USDC_NARROW_FEE]
  });

  if (poolAddress === ZERO_ADDRESS) throw new Error("WETH/USDC 0.3% pool not found");

  const [slot0, token0, token1] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token1" })
  ]);

  return {
    currentTick: Number(slot0[1]),
    token0,
    token1
  };
}

export async function GET() {
  if (!(await isAuthenticated())) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  try {
    const walletAddress = getAddress(getConfig().BASE_WALLET_ADDRESS);
    const walletRecord = await prisma.wallet.findUnique({ where: { address: walletAddress } });
    const [wallet, positions, livePool] = await Promise.all([
      getWalletAssetAmountsSnapshot(walletAddress).catch(() => ({ weth: null, usdc: null })),
      walletRecord
        ? prisma.position.findMany({ where: { walletId: walletRecord.id }, orderBy: [{ tokenId: "desc" }, { createdAt: "desc" }] })
        : Promise.resolve([]),
      livePoolSnapshot().catch(() => null)
    ]);
    const pool = livePool ?? latestSyncedPoolSnapshot(positions);
    if (!pool) throw new Error("No live or synced WETH/USDC 0.3% pool tick available");

    const price = priceFromTick({ tick: pool.currentTick, token0: pool.token0, token1: pool.token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
    if (!price) throw new Error("Unable to calculate WETH/USDC pool price");

    return NextResponse.json(
      calculateTripleRangeGuide({
        positions,
        walletWeth: wallet.weth,
        walletUsdc: wallet.usdc,
        currentTick: pool.currentTick,
        price,
        token0: pool.token0,
        token1: pool.token1
      })
    );
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to calculate triple range guide" }, { status: 500 });
  }
}
