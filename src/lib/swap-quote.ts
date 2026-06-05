import { formatUnits, getAddress, parseUnits, type Address, type Hex } from "viem";
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

export type SwapQuoteSource = "uniswap_v3" | "zeroex_allowance_holder" | "odos_router" | "aggregator_required";

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
  transactionData?: Hex;
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
    executable: sourceType === "uniswap_v3" || sourceType === "zeroex_allowance_holder" || sourceType === "odos_router",
    executionNote:
      sourceType === "uniswap_v3"
        ? "Executable by the current Uniswap-only rebalancer contract."
        : sourceType === "zeroex_allowance_holder"
          ? "Executable by the allowlisted 0x AllowanceHolder rebalancer contract."
          : sourceType === "odos_router"
            ? "Odos router calldata can be executed by an Odos-allowlisted atomic rebalancer contract."
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

type OdosQuoteResponse = {
  pathId?: string;
  outAmounts?: string[];
  gasEstimate?: number | string;
  priceImpact?: number;
  percentDiff?: number;
  message?: string;
  detail?: string;
};

type OdosAssembleResponse = {
  transaction?: {
    to?: string;
    data?: string;
    gas?: number | string;
    value?: string;
  };
  simulation?: {
    isSuccess?: boolean;
    simulationError?: unknown;
    amountsOut?: string[];
    gasEstimate?: number | string;
  };
  gasEstimate?: number | string;
  message?: string;
  detail?: string;
};

function routeSummary(fills: NonNullable<ZeroExQuoteResponse["route"]>["fills"]) {
  if (!fills || fills.length === 0) return "route unavailable";
  return fills
    .slice(0, 4)
    .map((fill) => `${fill.source ?? "unknown"} ${Number(fill.proportionBps ?? 0) / 100}%`)
    .join(", ");
}

function sameAddress(left?: string, right?: string) {
  return !!left && !!right && left.toLowerCase() === right.toLowerCase();
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
    taker: getConfig().AUTOPILOT_REBALANCER_ADDRESS || getConfig().BASE_WALLET_ADDRESS,
    slippageBps: String(getConfig().AUTOPILOT_SWAP_SLIPPAGE_BPS)
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

  const approvalTarget = body.issues?.allowance?.spender;
  const transactionTarget = body.transaction?.to;
  const transactionData = body.transaction?.data;
  const isAllowanceHolderRoute =
    sameAddress(approvalTarget, CONTRACTS.zeroExAllowanceHolder) &&
    sameAddress(transactionTarget, CONTRACTS.zeroExAllowanceHolder) &&
    typeof transactionData === "string" &&
    transactionData.startsWith("0x");
  const quote = quoteFromRaw(
    request,
    amountInRaw,
    BigInt(body.buyAmount),
    body.gas ?? "0",
    "0x AllowanceHolder",
    isAllowanceHolderRoute ? "zeroex_allowance_holder" : "aggregator_required"
  );
  return {
    ...quote,
    executable: isAllowanceHolderRoute,
    executionNote: isAllowanceHolderRoute
      ? "0x AllowanceHolder calldata can be executed by the allowlisted atomic rebalancer."
      : "0x returned an aggregator route outside the allowlisted AllowanceHolder path.",
    approvalTarget: approvalTarget ? getAddress(approvalTarget) : undefined,
    transactionTarget: transactionTarget ? getAddress(transactionTarget) : undefined,
    transactionData: isAllowanceHolderRoute ? (transactionData as Hex) : undefined,
    routeSummary: routeSummary(body.route?.fills)
  };
}

function odosHeaders() {
  const apiKey = getConfig().ODOS_API_KEY;
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { "x-api-key": apiKey } : {})
  };
}

function odosBaseUrl() {
  return getConfig().ODOS_API_BASE_URL.replace(/\/+$/, "");
}

export async function quoteOdosRouter(request: SwapQuoteRequest): Promise<SwapQuote> {
  const amountInRaw = quoteAmountInRaw(request);
  const rebalancerAddress = getConfig().AUTOPILOT_REBALANCER_ADDRESS;
  const userAddress = rebalancerAddress || getConfig().BASE_WALLET_ADDRESS;
  const slippageLimitPercent = getConfig().AUTOPILOT_SWAP_SLIPPAGE_BPS / 100;
  const quoteResponse = await fetch(`${odosBaseUrl()}/sor/quote/v3`, {
    method: "POST",
    headers: odosHeaders(),
    body: JSON.stringify({
      chainId: BASE_CHAIN_ID,
      inputTokens: [
        {
          tokenAddress: request.tokenIn,
          amount: amountInRaw.toString()
        }
      ],
      outputTokens: [
        {
          tokenAddress: request.tokenOut,
          proportion: 1
        }
      ],
      userAddr: userAddress,
      slippageLimitPercent,
      compact: false
    })
  });
  const quoteBody = (await quoteResponse.json().catch(() => ({}))) as OdosQuoteResponse;
  const pathId = quoteBody.pathId;
  const quotedOutRaw = quoteBody.outAmounts?.[0];
  if (!quoteResponse.ok || !pathId || !quotedOutRaw) {
    throw new Error(quoteBody.message || quoteBody.detail || `Odos quote failed with status ${quoteResponse.status}`);
  }

  const assembleResponse = await fetch(`${odosBaseUrl()}/sor/assemble`, {
    method: "POST",
    headers: odosHeaders(),
    body: JSON.stringify({
      userAddr: userAddress,
      pathId,
      simulate: false,
      receiver: userAddress
    })
  });
  const assembleBody = (await assembleResponse.json().catch(() => ({}))) as OdosAssembleResponse;
  const transactionTarget = assembleBody.transaction?.to;
  const transactionData = assembleBody.transaction?.data;
  const simulationFailed = assembleBody.simulation && assembleBody.simulation.isSuccess === false;
  if (!assembleResponse.ok || simulationFailed || !transactionTarget || !transactionData?.startsWith("0x")) {
    const simulationError = assembleBody.simulation?.simulationError ? `; simulation: ${JSON.stringify(assembleBody.simulation.simulationError).slice(0, 240)}` : "";
    throw new Error(assembleBody.message || assembleBody.detail || `Odos assemble failed with status ${assembleResponse.status}${simulationError}`);
  }

  const amountOutRaw = assembleBody.simulation?.amountsOut?.[0] ?? quotedOutRaw;
  const gasEstimate = assembleBody.transaction?.gas ?? assembleBody.gasEstimate ?? quoteBody.gasEstimate ?? "0";
  const quote = quoteFromRaw(request, amountInRaw, BigInt(amountOutRaw), String(gasEstimate), "Odos SOR", "odos_router");
  return {
    ...quote,
    executable: sameAddress(transactionTarget, CONTRACTS.odosSmartOrderRouterV3),
    executionNote: sameAddress(transactionTarget, CONTRACTS.odosSmartOrderRouterV3)
      ? "Odos router calldata can be executed by an Odos-allowlisted atomic rebalancer contract."
      : "Odos returned a router target that is not the configured Odos SOR v3 router.",
    approvalTarget: getAddress(transactionTarget),
    transactionTarget: getAddress(transactionTarget),
    transactionData: transactionData as Hex,
    routeSummary: `path ${pathId}${quoteBody.percentDiff === undefined ? "" : `, percentDiff ${quoteBody.percentDiff}%`}${quoteBody.priceImpact === undefined ? "" : `, priceImpact ${quoteBody.priceImpact}%`}`
  };
}

export async function quoteBestExecutableSwap(request: SwapQuoteRequest): Promise<SwapQuote> {
  const provider = getConfig().AUTOPILOT_SWAP_PROVIDER;
  if (provider === "zeroex") {
    return quoteZeroExAllowanceHolder(request);
  }
  if (provider === "odos") {
    return quoteOdosRouter(request);
  }

  const fallback = await quoteUniswapV3ExactInputSingle(request);
  if (provider === "uniswap_v3") return fallback;
  return {
    ...fallback,
    source: `${fallback.source} fallback; ${provider} scouting not configured`,
    executionNote: `${provider} is selected, but its adapter is not implemented yet. Falling back to executable Uniswap v3 quote.`
  };
}
