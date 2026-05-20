import { formatUnits, getAddress, type Address } from "viem";
import { positionManagerAbi } from "./abi";
import { createBaseClient } from "./chain";
import { CONTRACTS, TOKEN_META } from "./constants";

const MAX_UINT128 = 2n ** 128n - 1n;

function amountForToken(token: string, rawAmount: bigint) {
  const meta = TOKEN_META[token.toLowerCase()];
  if (!meta) return 0;
  return Number(formatUnits(rawAmount, meta.decimals));
}

export async function getUncollectedPositionFees(input: {
  tokenId: string;
  token0: string;
  token1: string;
  walletAddress: Address;
}) {
  const client = createBaseClient();
  const [amount0, amount1] = await client
    .simulateContract({
      account: input.walletAddress,
      address: CONTRACTS.nonfungiblePositionManager,
      abi: positionManagerAbi,
      functionName: "collect",
      args: [
        {
          tokenId: BigInt(input.tokenId),
          recipient: input.walletAddress,
          amount0Max: MAX_UINT128,
          amount1Max: MAX_UINT128
        }
      ]
    })
    .then((result) => result.result);

  const token0 = getAddress(input.token0);
  const token1 = getAddress(input.token1);
  const weth = getAddress(CONTRACTS.weth);
  const usdc = getAddress(CONTRACTS.usdc);

  return {
    weth: (token0 === weth ? amountForToken(token0, amount0) : 0) + (token1 === weth ? amountForToken(token1, amount1) : 0),
    usdc: (token0 === usdc ? amountForToken(token0, amount0) : 0) + (token1 === usdc ? amountForToken(token1, amount1) : 0)
  };
}
