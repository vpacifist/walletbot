import { PositionStatus } from "@/generated/prisma/client";
import { getAddress, type Address, zeroAddress } from "viem";
import { erc721OwnerAbi, factoryAbi, poolAbi, positionManagerAbi } from "./abi";
import { baseRpcUrlsWithPublicFallback, createBaseClient, createBaseClientForUrl } from "./chain";
import { CONTRACTS } from "./constants";
import { prisma } from "./db";
import { getConfig } from "./config";
import { getPositionTokenAmounts } from "./uniswap-v3-position";

function tokenPairIsWethUsdc(token0: string, token1: string) {
  const pair = new Set([token0.toLowerCase(), token1.toLowerCase()]);
  return pair.has(CONTRACTS.weth.toLowerCase()) && pair.has(CONTRACTS.usdc.toLowerCase());
}

async function readWithFallback<T>(read: (client: ReturnType<typeof createBaseClient>) => Promise<T>) {
  try {
    return await read(createBaseClient());
  } catch (primaryError) {
    let lastError = primaryError;
    for (const url of baseRpcUrlsWithPublicFallback()) {
      try {
        return await read(createBaseClientForUrl(url));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

export function calculateRangeStatus(input: {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
}) {
  if (input.liquidity === 0n) return PositionStatus.closed_or_zero_liquidity;
  if (input.currentTick < input.tickLower) return PositionStatus.below_range;
  if (input.currentTick >= input.tickUpper) return PositionStatus.above_range;
  return PositionStatus.in_range;
}

export async function discoverOwnedPositionTokenIds(walletAddress: Address) {
  const balance = await readWithFallback((client) => client.readContract({
    address: CONTRACTS.nonfungiblePositionManager,
    abi: erc721OwnerAbi,
    functionName: "balanceOf",
    args: [walletAddress]
  }));

  const owned = await Promise.all(
    Array.from({ length: Number(balance) }, (_, index) =>
      readWithFallback((client) => client.readContract({
        address: CONTRACTS.nonfungiblePositionManager,
        abi: erc721OwnerAbi,
        functionName: "tokenOfOwnerByIndex",
        args: [walletAddress, BigInt(index)]
      }))
    )
  );

  return owned.map((tokenId) => tokenId.toString());
}

export async function upsertTrackedPositions(walletId: string, walletAddress: Address, extraTokenIds: string[] = []) {
  const ownedTokenIds = await discoverOwnedPositionTokenIds(walletAddress).catch(() => []);
  const tokenIds = [...new Set([...ownedTokenIds, ...extraTokenIds])];
  const positions = [];

  for (const tokenId of tokenIds) {
    const position = await readWithFallback((client) => client.readContract({
        address: CONTRACTS.nonfungiblePositionManager,
        abi: positionManagerAbi,
        functionName: "positions",
        args: [BigInt(tokenId)]
      }))
      .catch(() => null);

    if (!position) continue;

    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = position;
    if (!tokenPairIsWethUsdc(token0, token1)) continue;

    const poolAddress = await readWithFallback((client) => client.readContract({
      address: CONTRACTS.uniswapV3Factory,
      abi: factoryAbi,
      functionName: "getPool",
      args: [token0, token1, fee]
    }));

    let currentTick: number | null = null;
    let status: PositionStatus = PositionStatus.unknown;
    let wethAmount: string | null = null;
    let usdcAmount: string | null = null;

    if (poolAddress !== zeroAddress) {
      const slot0 = await readWithFallback((client) => client.readContract({
        address: poolAddress,
        abi: poolAbi,
        functionName: "slot0"
      }));
      currentTick = slot0[1];
      status = calculateRangeStatus({
        liquidity,
        tickLower,
        tickUpper,
        currentTick
      });
      const amounts = getPositionTokenAmounts({
        token0,
        token1,
        liquidity,
        tickLower,
        tickUpper,
        currentTick
      });
      wethAmount = amounts.weth;
      usdcAmount = amounts.usdc;
    }

    const saved = await prisma.position.upsert({
      where: { walletId_tokenId: { walletId, tokenId } },
      create: {
        walletId,
        tokenId,
        poolAddress: poolAddress === zeroAddress ? null : getAddress(poolAddress),
        token0: getAddress(token0),
        token1: getAddress(token1),
        fee,
        tickLower,
        tickUpper,
        currentTick,
        liquidity: liquidity.toString(),
        wethAmount,
        usdcAmount,
        status,
        lastCheckedAt: new Date(),
        raw: {
          token0,
          token1,
          fee,
          tickLower,
          tickUpper,
          liquidity: liquidity.toString(),
          wethAmount,
          usdcAmount
        }
      },
      update: {
        poolAddress: poolAddress === zeroAddress ? null : getAddress(poolAddress),
        currentTick,
        liquidity: liquidity.toString(),
        wethAmount,
        usdcAmount,
        status,
        lastCheckedAt: new Date(),
        raw: {
          token0,
          token1,
          fee,
          tickLower,
          tickUpper,
          liquidity: liquidity.toString(),
          wethAmount,
          usdcAmount
        }
      }
    });
    positions.push(saved);
  }

  return positions;
}

export async function refreshTrackedPositionsForWallet(extraTokenIds: string[] = []) {
  const walletAddress = getAddress(getConfig().BASE_WALLET_ADDRESS);
  const wallet = await prisma.wallet.findUnique({ where: { address: walletAddress } });
  if (!wallet) return [];

  return upsertTrackedPositions(wallet.id, walletAddress, extraTokenIds);
}
