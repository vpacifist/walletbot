import { formatUnits, parseUnits, type Address } from "viem";
import { quoterV2Abi } from "./abi";
import { createBaseClient } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS, TOKEN_META } from "./constants";

export type SwapQuoteRequest = {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: number;
  spendSymbol: "WETH" | "USDC";
  receiveSymbol: "WETH" | "USDC";
};

export type SwapQuoteSource = "uniswap_v3" | "aggregator_required";

export type SwapQuote = SwapQuoteRequest & {
  amountInRaw: string;
  amountOut: number;
  amountOutRaw: string;
  effectivePrice: number;
  gasEstimate: string;
  source: string;
  sourceType: SwapQuoteSource;
  executable: boolean;
  executionNote?: string;
};

export function quoteRequestKey(request: SwapQuoteRequest) {
  return [
    request.tokenIn.toLowerCase(),
    request.tokenOut.toLowerCase(),
    request.fee,
    request.amountIn.toPrecision(16),
    request.spendSymbol,
    request.receiveSymbol
  ].join(":");
}

export function quoteAmountInRaw(request: SwapQuoteRequest) {
  const tokenInMeta = TOKEN_META[request.tokenIn.toLowerCase()];
  if (!tokenInMeta) throw new Error("Unsupported quote token");
  if (request.amountIn <= 0 || !Number.isFinite(request.amountIn)) throw new Error("Invalid quote amount");
  return parseUnits(request.amountIn.toFixed(tokenInMeta.decimals), tokenInMeta.decimals);
}

function quoteFromRaw(request: SwapQuoteRequest, amountInRaw: bigint, amountOutRaw: bigint, gasEstimate: bigint | string, source: string, sourceType: SwapQuoteSource): SwapQuote {
  const tokenOutMeta = TOKEN_META[request.tokenOut.toLowerCase()];
  if (!tokenOutMeta) throw new Error("Unsupported quote token");
  const amountOut = Number(formatUnits(amountOutRaw, tokenOutMeta.decimals));
  const effectivePrice =
    request.spendSymbol === "WETH" && request.receiveSymbol === "USDC"
      ? amountOut / request.amountIn
      : request.amountIn / amountOut;

  return {
    ...request,
    amountInRaw: amountInRaw.toString(),
    amountOut,
    amountOutRaw: amountOutRaw.toString(),
    effectivePrice,
    gasEstimate: gasEstimate.toString(),
    source,
    sourceType,
    executable: sourceType === "uniswap_v3",
    executionNote:
      sourceType === "uniswap_v3"
        ? "Executable by the current Uniswap-only rebalancer contract."
        : "Aggregator quote requires a rebalancer contract that supports generic aggregator calldata."
  };
}

export async function quoteUniswapV3ExactInputSingle(request: SwapQuoteRequest): Promise<SwapQuote> {
  const tokenInMeta = TOKEN_META[request.tokenIn.toLowerCase()];
  const tokenOutMeta = TOKEN_META[request.tokenOut.toLowerCase()];
  if (!tokenInMeta || !tokenOutMeta) throw new Error("Unsupported quote token");

  const amountInRaw = quoteAmountInRaw(request);
  const client = createBaseClient();
  const result = await client.simulateContract({
    address: CONTRACTS.uniswapV3QuoterV2,
    abi: quoterV2Abi,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: request.tokenIn,
        tokenOut: request.tokenOut,
        amountIn: amountInRaw,
        fee: request.fee,
        sqrtPriceLimitX96: 0n
      }
    ]
  });
  const [amountOutRaw, , , gasEstimate] = result.result;
  return quoteFromRaw(request, amountInRaw, amountOutRaw, gasEstimate, "Uniswap QuoterV2", "uniswap_v3");
}

export async function quoteBestExecutableSwap(request: SwapQuoteRequest): Promise<SwapQuote> {
  const provider = getConfig().AUTOPILOT_SWAP_PROVIDER;
  const fallback = await quoteUniswapV3ExactInputSingle(request);
  if (provider === "uniswap_v3") return fallback;

  return {
    ...fallback,
    source: `${fallback.source} fallback; ${provider} scouting not configured`,
    executionNote: `${provider} is selected, but aggregator calldata is not supported by the deployed rebalancer yet. Falling back to executable Uniswap v3 quote.`
  };
}
