import { formatUnits, parseUnits, type Address } from "viem";
import { quoterV2Abi } from "./abi";
import { createBaseClient } from "./chain";
import { CONTRACTS, TOKEN_META } from "./constants";

export type SwapQuoteRequest = {
  tokenIn: Address;
  tokenOut: Address;
  fee: number;
  amountIn: number;
  spendSymbol: "WETH" | "USDC";
  receiveSymbol: "WETH" | "USDC";
};

export type SwapQuote = SwapQuoteRequest & {
  amountInRaw: string;
  amountOut: number;
  amountOutRaw: string;
  effectivePrice: number;
  gasEstimate: string;
  source: "Uniswap QuoterV2";
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

export async function quoteExactInputSingle(request: SwapQuoteRequest): Promise<SwapQuote> {
  const tokenInMeta = TOKEN_META[request.tokenIn.toLowerCase()];
  const tokenOutMeta = TOKEN_META[request.tokenOut.toLowerCase()];
  if (!tokenInMeta || !tokenOutMeta) throw new Error("Unsupported quote token");
  if (request.amountIn <= 0 || !Number.isFinite(request.amountIn)) throw new Error("Invalid quote amount");

  const amountInRaw = parseUnits(request.amountIn.toFixed(tokenInMeta.decimals), tokenInMeta.decimals);
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
    source: "Uniswap QuoterV2"
  };
}
