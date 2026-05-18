import { getAddress, type Address, zeroAddress } from "viem";
import { factoryAbi } from "./abi";
import type { createBaseClient } from "./chain";
import { CONTRACTS, WETH_USDC_FEE_TIERS } from "./constants";

export async function getWethUsdcUniswapV3PoolAddresses(client: ReturnType<typeof createBaseClient>) {
  const pools = await Promise.all(
    WETH_USDC_FEE_TIERS.map((fee) =>
      client.readContract({
        address: CONTRACTS.uniswapV3Factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [CONTRACTS.weth, CONTRACTS.usdc, fee]
      })
    )
  );

  return new Set(
    pools
      .filter((pool): pool is Address => pool !== zeroAddress)
      .map((pool) => getAddress(pool).toLowerCase())
  );
}
