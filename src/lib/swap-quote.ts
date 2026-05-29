import { formatUnits, parseUnits, type Address } from "viem";
import { quoterV2Abi } from "./abi";
import { createBaseClient } from "./chain";
import { getConfig } from "./config";
import { BASE_CHAIN_ID, CONTRACTS, TOKEN_META } from "./constants";

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
  approvalTarget?: Address;
  transactionTarget?: Address;
  routeSummary?: string;
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

type ZeroExQuoteResponse = {
  buyAmount?: string;
  sellAmount?: string;
  minBuyAmount?: string;
  gas?: string;
  liquidityAvailable?: boolean;
  transaction?: {
    to?: string;
    data?: string;
  };
  issues?: {
    allowance?: {
      spender?: string;
    };
  };
  route?: {
    fills?: Array<{
      source?: string;
      proportionBps?: string;
    }>;
  };
  message?: string;
  reason?: string;
  validationErrors?: unknown;
};

function routeSummary(fills: NonNullable<ZeroExQuoteResponse["route"]>["fills"]) {
  if (!fills || fills.length === 0) return "route unavailable";
  return fills
    .slice(0, 4)
    .map((fill) => `${fill.source ?? "unknown"} ${Number(fill.proportionBps ?? 0) / 100}%`)
    .join(", ");
}

export async function quoteZeroExAllowanceHolder(request: SwapQuoteRequest): Promise<SwapQuote> {
  const apiKey = getConfig().ZEROX_API_KEY;
  if (!apiKey) throw new Error("ZEROX_API_KEY is not configured");

  const amountInRaw = quoteAmountInRaw(request);
  const params = new URLSearchParams({
    chainId: String(BASE_CHAIN_ID),
    sellToken: request.tokenIn,
    buyToken: request.tokenOut,
    sellAmount: amountInRaw.toString(),
    taker: getConfig().AUTOPILOT_REBALANCER_ADDRESS || getConfig().BASE_WALLET_ADDRESS
  });

  const response = await fetch(`https://api.0x.org/swap/allowance-holder/quote?${params.toString()}`, {
    headers: {
      "0x-api-key": apiKey,
      "0x-version": "v2"
    }
  });
  const body = (await response.json().catch(() => ({}))) as ZeroExQuoteResponse;
  if (!response.ok || body.liquidityAvailable === false || !body.buyAmount) {
    throw new Error(body.message || body.reason || `0x quote failed with status ${response.status}`);
  }

  const quote = quoteFromRaw(request, amountInRaw, BigInt(body.buyAmount), body.gas ?? "0", "0x AllowanceHolder", "aggregator_required");
  return {
    ...quote,
    executable: false,
    executionNote: "0x returned an aggregator route, but the deployed rebalancer cannot execute generic aggregator calldata yet.",
    approvalTarget: body.issues?.allowance?.spender as Address | undefined,
    transactionTarget: body.transaction?.to as Address | undefined,
    routeSummary: routeSummary(body.route?.fills)
  };
}

export async function quoteBestExecutableSwap(request: SwapQuoteRequest): Promise<SwapQuote> {
  const provider = getConfig().AUTOPILOT_SWAP_PROVIDER;
  if (provider === "zeroex") {
    return quoteZeroExAllowanceHolder(request);
  }

  const fallback = await quoteUniswapV3ExactInputSingle(request);
  if (provider === "uniswap_v3") return fallback;
  return {
    ...fallback,
    source: `${fallback.source} fallback; ${provider} scouting not configured`,
    executionNote: `${provider} is selected, but its adapter is not implemented yet. Falling back to executable Uniswap v3 quote.`
  };
}
