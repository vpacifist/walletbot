import { encodeFunctionData, getAddress, parseUnits, type Address } from "viem";
import { positionManagerAbi, swapRouter02Abi } from "./abi";
import { createAutopilotExecutionPreview, type AutopilotExecutionPreview } from "./autopilot-execution-preview";
import { createBaseClient } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS, TOKEN_META } from "./constants";

type TransactionIntent =
  | {
      kind: "close_position";
      target: string;
      tokenId: string;
      description: string;
    }
  | {
      kind: "swap_exact_input";
      target: string;
      tokenIn: string;
      tokenOut: string;
      amountIn: number;
      expectedAmountOut: number | null;
      minAmountOut: number | null;
      slippageBps: number;
      tokenInAddress: Address;
      tokenOutAddress: Address;
      amountInRaw: string;
      minAmountOutRaw: string | null;
      description: string;
    }
  | {
      kind: "mint_position";
      target: string;
      lowerTick: number;
      upperTick: number;
      budgetUsd: number;
      description: string;
    }
  | {
      kind: "manual_review";
      target: string;
      description: string;
    };

export type AutopilotDryRunExecution = {
  planId: string;
  status: "validated" | "blocked";
  checks: Array<{
    label: string;
    ok: boolean;
    detail: string;
  }>;
  operations: Array<{
    label: string;
    detail: string;
  }>;
  intents: TransactionIntent[];
  calls: ExecutionCall[];
  telegramSummary: string;
};

const SLIPPAGE_BPS = 15;
const MAX_UINT128 = (1n << 128n) - 1n;

type ClosePositionState =
  | {
      status: "available";
      tokenId: string;
      liquidity: bigint;
      tokensOwed0: bigint;
      tokensOwed1: bigint;
    }
  | {
      status: "unavailable";
      tokenId: string;
      reason: string;
    };

type BuildExecutionOptions = {
  closePositions?: Record<string, ClosePositionState>;
};

type ExecutionCall = {
  intent: string;
  status: "prepared" | "blocked";
  target: string;
  functionName: string | null;
  dataPreview: string | null;
  reason: string;
};

function statusIcon(ok: boolean) {
  return ok ? "OK" : "BLOCKED";
}

function needsSwap(preview: AutopilotExecutionPreview) {
  return preview.steps.some((step) => step.type === "partial_swap");
}

function formatToken(value: number, symbol: string) {
  return `${value.toLocaleString("en-US", { maximumFractionDigits: symbol === "USDC" ? 2 : 6 })} ${symbol}`;
}

function formatUsd(value: number) {
  return `$${value.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function minAmountOut(amountOut: number) {
  return amountOut * (1 - SLIPPAGE_BPS / 10_000);
}

function tokenDecimals(address: string) {
  return TOKEN_META[address.toLowerCase()]?.decimals ?? 18;
}

function rawAmount(amount: number, tokenAddress: string) {
  return parseUnits(amount.toFixed(tokenDecimals(tokenAddress)), tokenDecimals(tokenAddress)).toString();
}

function intentSummary(intent: TransactionIntent) {
  if (intent.kind === "close_position") {
    return `Close position #${intent.tokenId} via ${intent.target}: ${intent.description}`;
  }
  if (intent.kind === "swap_exact_input") {
    const expected = intent.expectedAmountOut === null ? "quote unavailable" : formatToken(intent.expectedAmountOut, intent.tokenOut);
    const minimum = intent.minAmountOut === null ? "not set" : formatToken(intent.minAmountOut, intent.tokenOut);
    return `Swap ${formatToken(intent.amountIn, intent.tokenIn)} via ${intent.target}; expected ${expected}; min ${minimum} (${intent.slippageBps} bps).`;
  }
  if (intent.kind === "mint_position") {
    return `Mint ${intent.lowerTick} - ${intent.upperTick} via ${intent.target}; budget ${formatUsd(intent.budgetUsd)}.`;
  }
  return `Manual review: ${intent.description}`;
}

function buildIntents(preview: AutopilotExecutionPreview): TransactionIntent[] {
  const intents = preview.steps.map((step): TransactionIntent => {
    if (step.type === "close" && step.tokenId) {
      return {
        kind: "close_position",
        target: "Uniswap v3 NonfungiblePositionManager",
        tokenId: step.tokenId,
        description: step.detail
      };
    }

    if (step.type === "mint" && step.lowerTick !== undefined && step.upperTick !== undefined && step.budgetUsd !== undefined) {
      return {
        kind: "mint_position",
        target: "Uniswap v3 NonfungiblePositionManager",
        lowerTick: step.lowerTick,
        upperTick: step.upperTick,
        budgetUsd: step.budgetUsd,
        description: step.detail
      };
    }

    if (step.type === "partial_swap" && step.quoteRequest) {
      const quote = preview.quote.status === "available" ? preview.quote.data : null;
      return {
        kind: "swap_exact_input",
        target: "Uniswap v3 SwapRouter",
        tokenIn: step.quoteRequest.spendSymbol,
        tokenOut: step.quoteRequest.receiveSymbol,
        amountIn: step.quoteRequest.amountIn,
        expectedAmountOut: quote?.amountOut ?? null,
        minAmountOut: quote ? minAmountOut(quote.amountOut) : null,
        slippageBps: SLIPPAGE_BPS,
        tokenInAddress: step.quoteRequest.tokenIn,
        tokenOutAddress: step.quoteRequest.tokenOut,
        amountInRaw: rawAmount(step.quoteRequest.amountIn, step.quoteRequest.tokenIn),
        minAmountOutRaw: quote ? rawAmount(minAmountOut(quote.amountOut), step.quoteRequest.tokenOut) : null,
        description: step.detail
      };
    }

    return {
      kind: "manual_review",
      target: CONTRACTS.nonfungiblePositionManager,
      description: `${step.sourceLabel}: ${step.detail}`
    };
  });

  const priority: Record<TransactionIntent["kind"], number> = {
    close_position: 0,
    swap_exact_input: 1,
    mint_position: 2,
    manual_review: 3
  };

  return intents.sort((left, right) => priority[left.kind] - priority[right.kind]);
}

function dataPreview(data: string) {
  return `${data.slice(0, 18)}...${data.slice(-8)}`;
}

function shortError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Status: 429") || message.toLowerCase().includes("too many requests")) {
    return "RPC rate limit while reading close position state.";
  }
  if (message.length <= 160) return message;
  return `${message.slice(0, 157)}...`;
}

function buildCloseCalls(intent: Extract<TransactionIntent, { kind: "close_position" }>, index: number, state?: ClosePositionState): ExecutionCall[] {
  const intentLabel = `${index + 1}. close_position`;
  if (!state) {
    return [
      {
        intent: intentLabel,
        status: "blocked" as const,
        target: CONTRACTS.nonfungiblePositionManager,
        functionName: null,
        dataPreview: null,
        reason: "Close calldata needs live position state from NonfungiblePositionManager.positions(tokenId)."
      }
    ];
  }

  if (state.status === "unavailable") {
    return [
      {
        intent: intentLabel,
        status: "blocked" as const,
        target: CONTRACTS.nonfungiblePositionManager,
        functionName: null,
        dataPreview: null,
        reason: state.reason
      }
    ];
  }

  if (state.liquidity <= 0n) {
    return [
      {
        intent: intentLabel,
        status: "blocked" as const,
        target: CONTRACTS.nonfungiblePositionManager,
        functionName: null,
        dataPreview: null,
        reason: `Position #${intent.tokenId} has zero live liquidity.`
      }
    ];
  }

  const walletAddress = getAddress(getConfig().BASE_WALLET_ADDRESS);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 120);
  const decreaseData = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: BigInt(intent.tokenId),
        liquidity: state.liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline
      }
    ]
  });
  const collectData = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "collect",
    args: [
      {
        tokenId: BigInt(intent.tokenId),
        recipient: walletAddress,
        amount0Max: MAX_UINT128,
        amount1Max: MAX_UINT128
      }
    ]
  });

  return [
    {
      intent: `${intentLabel}.decreaseLiquidity`,
      status: "prepared" as const,
      target: CONTRACTS.nonfungiblePositionManager,
      functionName: "decreaseLiquidity",
      dataPreview: dataPreview(decreaseData),
      reason: `Simulation-only calldata prepared for full live liquidity ${state.liquidity.toString()}; min amounts are 0 for dry-run only.`
    },
    {
      intent: `${intentLabel}.collect`,
      status: "prepared" as const,
      target: CONTRACTS.nonfungiblePositionManager,
      functionName: "collect",
      dataPreview: dataPreview(collectData),
      reason: `Simulation-only calldata prepared with max collection; currently owed ${state.tokensOwed0.toString()} token0 / ${state.tokensOwed1.toString()} token1 before decrease.`
    }
  ];
}

function buildCalls(intents: TransactionIntent[], options: BuildExecutionOptions = {}): ExecutionCall[] {
  return intents.flatMap((intent, index) => {
    if (intent.kind === "swap_exact_input") {
      if (!intent.minAmountOutRaw) {
        return {
          intent: `${index + 1}. swap_exact_input`,
          status: "blocked" as const,
          target: CONTRACTS.uniswapV3SwapRouter02,
          functionName: "exactInputSingle",
          dataPreview: null,
          reason: "Swap calldata requires an available quote and amountOutMinimum."
        };
      }

      const data = encodeFunctionData({
        abi: swapRouter02Abi,
        functionName: "exactInputSingle",
        args: [
          {
            tokenIn: intent.tokenInAddress,
            tokenOut: intent.tokenOutAddress,
            fee: 3000,
            recipient: getAddress(getConfig().BASE_WALLET_ADDRESS),
            deadline: BigInt(Math.floor(Date.now() / 1000) + 120),
            amountIn: BigInt(intent.amountInRaw),
            amountOutMinimum: BigInt(intent.minAmountOutRaw),
            sqrtPriceLimitX96: 0n
          }
        ]
      });

      return {
        intent: `${index + 1}. swap_exact_input`,
        status: "prepared" as const,
        target: CONTRACTS.uniswapV3SwapRouter02,
        functionName: "exactInputSingle",
        dataPreview: dataPreview(data),
        reason: "Calldata prepared for dry-run review; simulation and submission remain disabled."
      };
    }

    if (intent.kind === "close_position") {
      return buildCloseCalls(intent, index, options.closePositions?.[intent.tokenId]);
    }

    if (intent.kind === "mint_position") {
      return {
        intent: `${index + 1}. mint_position`,
        status: "blocked" as const,
        target: CONTRACTS.nonfungiblePositionManager,
        functionName: null,
        dataPreview: null,
        reason: "Mint calldata needs token amount split after close/swap and approval checks."
      };
    }

    return {
      intent: `${index + 1}. manual_review`,
      status: "blocked" as const,
      target: intent.target,
      functionName: null,
      dataPreview: null,
      reason: "Manual review required before calldata can be prepared."
    };
  });
}

function buildTelegramSummary(execution: Omit<AutopilotDryRunExecution, "telegramSummary">) {
  return [
    "Executor dry run",
    `Plan id: ${execution.planId}`,
    `Status: ${execution.status}`,
    "",
    "Checks",
    ...execution.checks.map((check) => `${statusIcon(check.ok)} ${check.label}: ${check.detail}`),
    "",
    "Prepared operations",
    ...execution.operations.map((operation, index) => `${index + 1}. ${operation.label}: ${operation.detail}`),
    "",
    "Transaction intents",
    ...execution.intents.map((intent, index) => `${index + 1}. ${intentSummary(intent)}`),
    "",
    "Calldata / simulation",
    ...execution.calls.map((call) => `${statusIcon(call.status === "prepared")} ${call.intent}: ${call.functionName ?? "not prepared"} @ ${call.target}${call.dataPreview ? ` | ${call.dataPreview}` : ""} - ${call.reason}`),
    "",
    "Execution mode: dry run only. No on-chain transactions were sent."
  ].join("\n");
}

export function buildAutopilotDryRunExecution(preview: AutopilotExecutionPreview, options: BuildExecutionOptions = {}): AutopilotDryRunExecution {
  const swapRequired = needsSwap(preview);
  const quoteAvailable = !swapRequired || preview.quote.status === "available";
  const checks = [
    {
      label: "Preview readiness",
      ok: preview.status === "ready",
      detail: preview.status === "ready" ? "Execution preview passed all guardrails" : `Preview blocked by ${preview.reasons.join(", ")}`
    },
    {
      label: "Quote readiness",
      ok: quoteAvailable,
      detail: quoteAvailable ? "Required quote is available" : "Required swap quote is unavailable; retry before execution"
    },
    {
      label: "Transaction submission",
      ok: true,
      detail: "Disabled for this executor step"
    }
  ];
  const operations = preview.steps.map((step) => ({
    label: step.label,
    detail: step.detail
  }));
  const intents = buildIntents(preview);
  const calls = buildCalls(intents, options);
  const executionWithoutTelegram = {
    planId: preview.planId,
    status: checks.every((check) => check.ok) ? ("validated" as const) : ("blocked" as const),
    checks,
    operations,
    intents,
    calls
  };

  return {
    ...executionWithoutTelegram,
    telegramSummary: buildTelegramSummary(executionWithoutTelegram)
  };
}

async function fetchClosePositionState(tokenId: string): Promise<ClosePositionState> {
  try {
    const position = await createBaseClient().readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [BigInt(tokenId)]
    });
    return {
      status: "available",
      tokenId,
      liquidity: position[7],
      tokensOwed0: position[10],
      tokensOwed1: position[11]
    };
  } catch (error) {
    return {
      status: "unavailable",
      tokenId,
      reason: shortError(error)
    };
  }
}

export async function createAutopilotDryRunExecution(planId: string) {
  const preview = await createAutopilotExecutionPreview(planId);
  const closeTokenIds = preview.steps.filter((step) => step.type === "close" && step.tokenId).map((step) => step.tokenId as string);
  const closeStates = await Promise.all(closeTokenIds.map((tokenId) => fetchClosePositionState(tokenId)));
  return buildAutopilotDryRunExecution(preview, {
    closePositions: Object.fromEntries(closeStates.map((state) => [state.tokenId, state]))
  });
}
