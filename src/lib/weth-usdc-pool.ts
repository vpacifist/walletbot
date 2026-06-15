import { type Address } from "viem";
import { poolAbi } from "./abi";
import { baseRpcUrlsWithPublicFallback, createBaseClient, createBaseClientForUrl } from "./chain";
import { CONTRACTS } from "./constants";
import { priceFromTick } from "./narrow-range-rebalance";

export type WethUsdcPoolSnapshot = {
  currentTick: number;
  price: number;
  token0: Address;
  token1: Address;
};

async function readSnapshotWithClient(client: ReturnType<typeof createBaseClient>) {
  const slot0 = await client.readContract({
    address: CONTRACTS.wethUsdcUniswapV3Pool3000,
    abi: poolAbi,
    functionName: "slot0"
  });
  const currentTick = Number(slot0[1]);
  const price = priceFromTick({
    tick: currentTick,
    token0: CONTRACTS.weth,
    token1: CONTRACTS.usdc,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });

  if (!price || !Number.isFinite(price) || price <= 0) {
    throw new Error("Unable to calculate WETH/USDC 0.3% pool price.");
  }

  return {
    currentTick,
    price,
    token0: CONTRACTS.weth,
    token1: CONTRACTS.usdc
  };
}

export async function readWethUsdcPoolSnapshot(): Promise<WethUsdcPoolSnapshot> {
  const client = createBaseClient();
  try {
    return await readSnapshotWithClient(client);
  } catch (primaryError) {
    let lastError = primaryError;
    for (const url of baseRpcUrlsWithPublicFallback()) {
      try {
        return await readSnapshotWithClient(createBaseClientForUrl(url));
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }
}

export async function readWethUsdcPoolTick() {
  return (await readWethUsdcPoolSnapshot()).currentTick;
}
