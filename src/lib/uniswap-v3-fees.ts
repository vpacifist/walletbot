import { formatUnits, getAddress, type Address } from "viem";
import { positionManagerAbi } from "./abi";
import { baseRpcUrlsWithPublicFallback, createBaseClient, createBaseClientForUrl } from "./chain";
import { CONTRACTS, TOKEN_META } from "./constants";

const MAX_UINT128 = 2n ** 128n - 1n;

function amountForToken(token: string, rawAmount: bigint) {
  const meta = TOKEN_META[token.toLowerCase()];
  if (!meta) return 0;
  return Number(formatUnits(rawAmount, meta.decimals));
}

async function simulateCollect(input: { tokenId: string; walletAddress: Address }, client: ReturnType<typeof createBaseClient>) {
  return client
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
}

export async function getUncollectedPositionFees(input: {
  tokenId: string;
  token0: string;
  token1: string;
  walletAddress: Address;
}) {
  const client = createBaseClient();
  let amount0: bigint;
  let amount1: bigint;

  try {
    [amount0, amount1] = await simulateCollect(input, client);
  } catch (primaryError) {
    let lastError = primaryError;
    let result: readonly [bigint, bigint] | null = null;

    for (const url of baseRpcUrlsWithPublicFallback()) {
      try {
        result = await simulateCollect(input, createBaseClientForUrl(url));
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (!result) throw lastError;
    [amount0, amount1] = result;
  }

  const token0 = getAddress(input.token0);
  const token1 = getAddress(input.token1);
  const weth = getAddress(CONTRACTS.weth);
  const usdc = getAddress(CONTRACTS.usdc);

  return {
    weth: (token0 === weth ? amountForToken(token0, amount0) : 0) + (token1 === weth ? amountForToken(token1, amount1) : 0),
    usdc: (token0 === usdc ? amountForToken(token0, amount0) : 0) + (token1 === usdc ? amountForToken(token1, amount1) : 0)
  };
}
