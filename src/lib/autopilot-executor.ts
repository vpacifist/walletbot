import { encodeFunctionData, getAddress, parseUnits, type Address } from "viem";
import { autopilotRebalancerAbi, erc20Abi, positionManagerAbi, swapRouter02Abi } from "./abi";
import { createAutopilotExecutionPreview, type AutopilotExecutionPreview } from "./autopilot-execution-preview";
import { autopilotExecutorAddress, createBaseClient } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS, TOKEN_META } from "./constants";
import { priceFromTick, WETH_USDC_NARROW_FEE } from "./narrow-range-rebalance";

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
      gasEstimate: string | null;
      sourceType: "uniswap_v3" | "zeroex_allowance_holder" | "aggregator_required" | null;
      executable: boolean;
      approvalTarget?: Address;
      transactionTarget?: Address;
      transactionData?: `0x${string}`;
      executionNote?: string;
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
  atomicCall: AtomicRebalanceCall;
  telegramSummary: string;
};

const SWAP_SLIPPAGE_BPS = 15;
// Uniswap v3 mint can consume slightly different token amounts as price moves
// between planning and execution. A wider mint guard avoids reverting while
// unused token dust is still refunded to the vault.
const MINT_SLIPPAGE_BPS = 100;
const SMALL_CAPITAL_MAX_ZEROEX_ROUTE_GAS = 2_000_000n;
const MAX_UINT128 = (1n << 128n) - 1n;

type ClosePositionState =
  | {
      status: "available";
      tokenId: string;
      liquidity: bigint;
      tokensOwed0: bigint;
      tokensOwed1: bigint;
      decreaseAmount0?: bigint;
      decreaseAmount1?: bigint;
      decreaseQuoteError?: string;
    }
  | {
      status: "unavailable";
      tokenId: string;
      reason: string;
    };

type BuildExecutionOptions = {
  closePositions?: Record<string, ClosePositionState>;
  nftApprovals?: Record<string, NftApprovalState>;
  rebalancerRoles?: RebalancerRoleState;
  rebalancerAddress?: Address | "";
  allowances?: Record<string, bigint>;
  pool?: {
    currentTick: number;
    price: number;
  };
};

type ExecutionCall = {
  intent: string;
  status: "prepared" | "blocked";
  target: string;
  functionName: string | null;
  data: `0x${string}` | null;
  dataPreview: string | null;
  reason: string;
  simulation: {
    status: "not_run" | "simulated" | "failed" | "skipped";
    detail: string;
  };
};

type AtomicRebalanceCall = {
  status: "prepared" | "blocked";
  target: string;
  functionName: "rebalance";
  data: `0x${string}` | null;
  dataPreview: string | null;
  reason: string;
};

type NftApprovalState =
  | {
      status: "approved";
      tokenId: string;
      detail: string;
    }
  | {
      status: "not_approved";
      tokenId: string;
      detail: string;
    }
  | {
      status: "unavailable";
      tokenId: string;
      detail: string;
    };

type RebalancerRoleState =
  | {
      status: "roles_match";
      detail: string;
    }
  | {
      status: "roles_mismatch";
      detail: string;
    }
  | {
      status: "unavailable";
      detail: string;
    };

function simulation(status: ExecutionCall["simulation"]["status"], detail: string): ExecutionCall["simulation"] {
  return { status, detail };
}

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
  return amountOut * (1 - SWAP_SLIPPAGE_BPS / 10_000);
}

function tokenDecimals(address: string) {
  return TOKEN_META[address.toLowerCase()]?.decimals ?? 18;
}

function rawAmount(amount: number, tokenAddress: string) {
  return parseUnits(amount.toFixed(tokenDecimals(tokenAddress)), tokenDecimals(tokenAddress)).toString();
}

function rawAmountBigInt(amount: number, tokenAddress: string) {
  return BigInt(rawAmount(amount, tokenAddress));
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
        target: quote?.source ?? "Swap provider",
        tokenIn: step.quoteRequest.spendSymbol,
        tokenOut: step.quoteRequest.receiveSymbol,
        amountIn: step.quoteRequest.amountIn,
        expectedAmountOut: quote?.amountOut ?? null,
        minAmountOut: quote ? minAmountOut(quote.amountOut) : null,
        slippageBps: SWAP_SLIPPAGE_BPS,
        tokenInAddress: step.quoteRequest.tokenIn,
        tokenOutAddress: step.quoteRequest.tokenOut,
        amountInRaw: rawAmount(step.quoteRequest.amountIn, step.quoteRequest.tokenIn),
        minAmountOutRaw: quote ? rawAmount(minAmountOut(quote.amountOut), step.quoteRequest.tokenOut) : null,
        gasEstimate: quote?.gasEstimate ?? null,
        sourceType: quote?.sourceType ?? null,
        executable: quote?.executable ?? false,
        approvalTarget: quote?.approvalTarget,
        transactionTarget: quote?.transactionTarget,
        transactionData: quote?.transactionData,
        executionNote: quote?.executionNote,
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
        data: null,
        dataPreview: null,
        reason: "Close calldata needs live position state from NonfungiblePositionManager.positions(tokenId).",
        simulation: simulation("skipped", "Call is not prepared.")
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
        data: null,
        dataPreview: null,
        reason: state.reason,
        simulation: simulation("skipped", "Call is not prepared.")
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
        data: null,
        dataPreview: null,
        reason: `Position #${intent.tokenId} has zero live liquidity.`,
        simulation: simulation("skipped", "Call is not prepared.")
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
      data: decreaseData,
      dataPreview: dataPreview(decreaseData),
      reason: `Simulation-only calldata prepared for full live liquidity ${state.liquidity.toString()}; min amounts are 0 for dry-run only.`,
      simulation: simulation("not_run", "Simulation has not run yet.")
    },
    {
      intent: `${intentLabel}.collect`,
      status: "prepared" as const,
      target: CONTRACTS.nonfungiblePositionManager,
      functionName: "collect",
      data: collectData,
      dataPreview: dataPreview(collectData),
      reason: `Simulation-only calldata prepared with max collection; currently owed ${state.tokensOwed0.toString()} token0 / ${state.tokensOwed1.toString()} token1 before decrease.`,
      simulation: simulation("not_run", "Simulation has not run yet.")
    }
  ];
}

function allowanceKey(token: Address) {
  return `${token.toLowerCase()}:${CONTRACTS.nonfungiblePositionManager.toLowerCase()}`;
}

function mintDesiredAmounts(intent: Extract<TransactionIntent, { kind: "mint_position" }>, pool?: BuildExecutionOptions["pool"]) {
  const token0 = getAddress(CONTRACTS.weth);
  const token1 = getAddress(CONTRACTS.usdc);
  const price = pool?.price;
  if (!pool || !price || price <= 0) return null;

  if (pool.currentTick < intent.lowerTick) {
    return {
      token0,
      token1,
      amount0: rawAmountBigInt(intent.budgetUsd / price, token0),
      amount1: 0n
    };
  }

  if (pool.currentTick >= intent.upperTick) {
    return {
      token0,
      token1,
      amount0: 0n,
      amount1: rawAmountBigInt(intent.budgetUsd, token1)
    };
  }

  const lowerPrice = priceFromTick({ tick: intent.lowerTick, token0, token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
  const upperPrice = priceFromTick({ tick: intent.upperTick, token0, token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
  if (!lowerPrice || !upperPrice || lowerPrice <= 0 || upperPrice <= price) return null;

  const sqrtPrice = Math.sqrt(price);
  const sqrtLower = Math.sqrt(lowerPrice);
  const sqrtUpper = Math.sqrt(upperPrice);
  const usdcPerWethRatio = (sqrtPrice * sqrtUpper * (sqrtPrice - sqrtLower)) / (sqrtUpper - sqrtPrice);
  const weth = intent.budgetUsd / (price + usdcPerWethRatio);
  const usdc = intent.budgetUsd - weth * price;

  return {
    token0,
    token1,
    amount0: rawAmountBigInt(weth, token0),
    amount1: rawAmountBigInt(usdc, token1)
  };
}

function buildMintCall(intent: Extract<TransactionIntent, { kind: "mint_position" }>, index: number, options: BuildExecutionOptions): ExecutionCall {
  const amounts = mintDesiredAmounts(intent, options.pool);
  if (!amounts) {
    return {
      intent: `${index + 1}. mint_position`,
      status: "blocked",
      target: CONTRACTS.nonfungiblePositionManager,
      functionName: null,
      data: null,
      dataPreview: null,
      reason: "Mint calldata needs live pool price and a valid target range.",
      simulation: simulation("skipped", "Call is not prepared.")
    };
  }

  const allowance0 = options.allowances?.[allowanceKey(amounts.token0)];
  const allowance1 = options.allowances?.[allowanceKey(amounts.token1)];
  if (allowance0 === undefined || allowance1 === undefined) {
    return {
      intent: `${index + 1}. mint_position`,
      status: "blocked",
      target: CONTRACTS.nonfungiblePositionManager,
      functionName: null,
      data: null,
      dataPreview: null,
      reason: "Mint calldata needs WETH/USDC allowance checks.",
      simulation: simulation("skipped", "Call is not prepared.")
    };
  }

  const missing = [
    allowance0 < amounts.amount0 ? `WETH allowance ${allowance0.toString()} < desired ${amounts.amount0.toString()}` : null,
    allowance1 < amounts.amount1 ? `USDC allowance ${allowance1.toString()} < desired ${amounts.amount1.toString()}` : null
  ].filter(Boolean);
  if (missing.length > 0) {
    return {
      intent: `${index + 1}. mint_position`,
      status: "blocked",
      target: CONTRACTS.nonfungiblePositionManager,
      functionName: "mint",
      data: null,
      dataPreview: null,
      reason: `Missing approval: ${missing.join("; ")}.`,
      simulation: simulation("skipped", "Call is not prepared.")
    };
  }

  const data = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "mint",
    args: [
      {
        token0: amounts.token0,
        token1: amounts.token1,
        fee: WETH_USDC_NARROW_FEE,
        tickLower: intent.lowerTick,
        tickUpper: intent.upperTick,
        amount0Desired: amounts.amount0,
        amount1Desired: amounts.amount1,
        amount0Min: (amounts.amount0 * BigInt(10_000 - MINT_SLIPPAGE_BPS)) / 10_000n,
        amount1Min: (amounts.amount1 * BigInt(10_000 - MINT_SLIPPAGE_BPS)) / 10_000n,
        recipient: getAddress(getConfig().BASE_WALLET_ADDRESS),
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
      }
    ]
  });

  return {
    intent: `${index + 1}. mint_position`,
    status: "prepared",
    target: CONTRACTS.nonfungiblePositionManager,
    functionName: "mint",
    data,
    dataPreview: dataPreview(data),
    reason: `Simulation-only calldata prepared with amount0Desired ${amounts.amount0.toString()} / amount1Desired ${amounts.amount1.toString()}.`,
    simulation: simulation("not_run", "Simulation has not run yet.")
  };
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
          data: null,
          dataPreview: null,
          reason: "Swap calldata requires an available quote and amountOutMinimum.",
          simulation: simulation("skipped", "Call is not prepared.")
        };
      }

      if (intent.sourceType !== "uniswap_v3" && intent.sourceType !== "zeroex_allowance_holder") {
        return {
          intent: `${index + 1}. swap_exact_input`,
          status: "blocked" as const,
          target: intent.target,
          functionName: null,
          data: null,
          dataPreview: null,
          reason: intent.executionNote ?? "Selected swap source is not executable by the deployed rebalancer contract.",
          simulation: simulation("skipped", "Call is not prepared.")
        };
      }

      if (intent.sourceType === "zeroex_allowance_holder") {
        if (!intent.executable || !intent.transactionTarget || !intent.transactionData) {
          return {
            intent: `${index + 1}. swap_exact_input`,
            status: "blocked" as const,
            target: intent.target,
            functionName: null,
            data: null,
            dataPreview: null,
            reason: intent.executionNote ?? "0x swap calldata is missing or not executable.",
            simulation: simulation("skipped", "Call is not prepared.")
          };
        }

        return {
          intent: `${index + 1}. swap_exact_input`,
          status: "prepared" as const,
          target: intent.transactionTarget,
          functionName: "zeroExAllowanceHolder",
          data: intent.transactionData,
          dataPreview: dataPreview(intent.transactionData),
          reason: "0x AllowanceHolder calldata prepared for atomic rebalancer review; direct simulation remains disabled because it depends on prior close funds.",
          simulation: simulation("not_run", "Simulation has not run yet.")
        };
      }

      if (!intent.executable) {
        return {
          intent: `${index + 1}. swap_exact_input`,
          status: "blocked" as const,
          target: intent.target,
          functionName: null,
          data: null,
          dataPreview: null,
          reason: intent.executionNote ?? "Selected swap source is not executable by the deployed rebalancer contract.",
          simulation: simulation("skipped", "Call is not prepared.")
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
        data,
        dataPreview: dataPreview(data),
        reason: "Calldata prepared for dry-run review; simulation and submission remain disabled.",
        simulation: simulation("not_run", "Simulation has not run yet.")
      };
    }

    if (intent.kind === "close_position") {
      return buildCloseCalls(intent, index, options.closePositions?.[intent.tokenId]);
    }

    if (intent.kind === "mint_position") {
      return buildMintCall(intent, index, options);
    }

    return {
      intent: `${index + 1}. manual_review`,
      status: "blocked" as const,
      target: intent.target,
      functionName: null,
      data: null,
      dataPreview: null,
      reason: "Manual review required before calldata can be prepared.",
      simulation: simulation("skipped", "Call is not prepared.")
    };
  });
}

function buildAtomicRebalanceCall(intents: TransactionIntent[], options: BuildExecutionOptions = {}): AtomicRebalanceCall {
  const closeIntent = intents.find((intent): intent is Extract<TransactionIntent, { kind: "close_position" }> => intent.kind === "close_position");
  const swapIntent = intents.find((intent): intent is Extract<TransactionIntent, { kind: "swap_exact_input" }> => intent.kind === "swap_exact_input");
  const mintIntent = intents.find((intent): intent is Extract<TransactionIntent, { kind: "mint_position" }> => intent.kind === "mint_position");
  const configuredRebalancer = options.rebalancerAddress ?? getConfig().AUTOPILOT_REBALANCER_ADDRESS;
  const target = configuredRebalancer ? getAddress(configuredRebalancer) : "AUTOPILOT_REBALANCER_ADDRESS not configured";
  const approvalStates = closeIntent ? [options.nftApprovals?.[closeIntent.tokenId]].filter(Boolean) : [];
  const approvalReady = approvalStates.length > 0 && approvalStates.every((approval) => approval?.status === "approved");

  if (!closeIntent || !swapIntent || !mintIntent) {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: "Atomic rebalance requires close, swap, and mint intents in the same approved plan."
    };
  }

  const closeState = options.closePositions?.[closeIntent.tokenId];
  if (!closeState) {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: "Atomic rebalance needs live liquidity for the close position."
    };
  }

  if (closeState.status === "unavailable") {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: closeState.reason
    };
  }

  if (closeState.liquidity <= 0n) {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: `Position #${closeIntent.tokenId} has zero live liquidity.`
    };
  }

  if (!swapIntent.minAmountOutRaw) {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: "Atomic rebalance needs an available swap quote and amountOutMinimum."
    };
  }

  if ((swapIntent.sourceType !== "uniswap_v3" && swapIntent.sourceType !== "zeroex_allowance_holder") || !swapIntent.executable) {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: swapIntent.executionNote ?? "Atomic rebalance cannot execute the selected aggregator route with the deployed rebalancer contract."
    };
  }

  const swapSpender = swapIntent.sourceType === "zeroex_allowance_holder" ? swapIntent.approvalTarget : CONTRACTS.uniswapV3SwapRouter02;
  const swapTarget = swapIntent.sourceType === "zeroex_allowance_holder" ? swapIntent.transactionTarget : CONTRACTS.uniswapV3SwapRouter02;
  const swapData = swapIntent.sourceType === "zeroex_allowance_holder" ? swapIntent.transactionData : "0x";
  if (!swapSpender || !swapTarget || !swapData) {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: "Atomic rebalance needs executable swap spender, target, and calldata."
    };
  }

  const atomicAmounts = atomicMintAmounts(mintIntent, swapIntent, closeState, options.pool);
  if (atomicAmounts.status === "blocked") {
    return {
      status: "blocked",
      target,
      functionName: "rebalance",
      data: null,
      dataPreview: null,
      reason: atomicAmounts.reason
    };
  }
  const mintAmounts = atomicAmounts.amounts;

  const data = encodeFunctionData({
    abi: autopilotRebalancerAbi,
    functionName: "rebalance",
    args: [
      {
        closePosition: {
          tokenId: BigInt(closeIntent.tokenId),
          liquidity: closeState.liquidity,
          amount0Min: 0n,
          amount1Min: 0n
        },
        swap: {
          tokenIn: swapIntent.tokenInAddress,
          tokenOut: swapIntent.tokenOutAddress,
          amountIn: BigInt(swapIntent.amountInRaw),
          amountOutMinimum: BigInt(swapIntent.minAmountOutRaw),
          sqrtPriceLimitX96: 0n,
          spender: getAddress(swapSpender),
          target: getAddress(swapTarget),
          data: swapData
        },
        mintPosition: {
          tickLower: mintIntent.lowerTick,
          tickUpper: mintIntent.upperTick,
          amount0Desired: mintAmounts.amount0,
          amount1Desired: mintAmounts.amount1,
          amount0Min: (mintAmounts.amount0 * BigInt(10_000 - MINT_SLIPPAGE_BPS)) / 10_000n,
          amount1Min: (mintAmounts.amount1 * BigInt(10_000 - MINT_SLIPPAGE_BPS)) / 10_000n
        },
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
      }
    ]
  });

  return {
    status: "prepared",
    target,
    functionName: "rebalance",
    data,
    dataPreview: dataPreview(data),
    reason: configuredRebalancer
      ? `Single-call contract calldata prepared for dry-run review; live execution still disabled; ${approvalReady ? "NFT approval is ready." : "NFT approval still needs to be checked."}${atomicAmounts.capped ? ` Mint is capped to conservative post-swap balances ${atomicAmounts.available0.toString()} token0 / ${atomicAmounts.available1.toString()} token1.` : ""}`
      : "Single-call contract calldata prepared, but live execution needs AUTOPILOT_REBALANCER_ADDRESS."
  };
}

function buildApprovalChecks(intents: TransactionIntent[], options: BuildExecutionOptions = {}) {
  const closeIntents = intents.filter((intent): intent is Extract<TransactionIntent, { kind: "close_position" }> => intent.kind === "close_position");
  if (closeIntents.length === 0 || !options.nftApprovals) return [];

  const configuredRebalancer = options.rebalancerAddress ?? getConfig().AUTOPILOT_REBALANCER_ADDRESS;
  if (!configuredRebalancer) {
    return [
      {
        label: "Rebalancer contract",
        ok: false,
        detail: "AUTOPILOT_REBALANCER_ADDRESS is not configured"
      }
    ];
  }

  return closeIntents.map((intent) => {
    const approval = options.nftApprovals?.[intent.tokenId];
    if (!approval) {
      return {
        label: `NFT approval #${intent.tokenId}`,
        ok: false,
        detail: "Approval state was not checked"
      };
    }

    return {
      label: `NFT approval #${intent.tokenId}`,
      ok: approval.status === "approved",
      detail: approval.detail
    };
  });
}

function scaleMintAmountsToBalances(amounts: NonNullable<ReturnType<typeof mintDesiredAmounts>>, available0: bigint, available1: bigint) {
  const scale = 1_000_000_000_000n;
  if (amounts.amount0 === 0n && amounts.amount1 === 0n) return null;

  if (amounts.amount0 === 0n) {
    const amount1 = amounts.amount1 < available1 ? amounts.amount1 : available1;
    return amount1 > 0n ? { ...amounts, amount1 } : null;
  }

  if (amounts.amount1 === 0n) {
    const amount0 = amounts.amount0 < available0 ? amounts.amount0 : available0;
    return amount0 > 0n ? { ...amounts, amount0 } : null;
  }

  const scale0 = (available0 * scale) / amounts.amount0;
  const scale1 = (available1 * scale) / amounts.amount1;
  const boundedScale = [scale, scale0, scale1].reduce((min, value) => (value < min ? value : min), scale);
  if (boundedScale <= 0n) return null;

  const amount0 = (amounts.amount0 * boundedScale) / scale;
  const amount1 = (amounts.amount1 * boundedScale) / scale;
  if (amount0 <= 0n && amount1 <= 0n) return null;
  return {
    ...amounts,
    amount0,
    amount1
  };
}

function atomicMintAmounts(
  mintIntent: Extract<TransactionIntent, { kind: "mint_position" }>,
  swapIntent: Extract<TransactionIntent, { kind: "swap_exact_input" }>,
  closeState: Extract<ClosePositionState, { status: "available" }>,
  pool?: BuildExecutionOptions["pool"]
) {
  const desired = mintDesiredAmounts(mintIntent, pool);
  if (!desired) {
    return {
      status: "blocked" as const,
      reason: "Atomic rebalance needs live pool price and a valid target mint range."
    };
  }

  if (closeState.decreaseAmount0 === undefined || closeState.decreaseAmount1 === undefined) {
    return {
      status: "blocked" as const,
      reason: closeState.decreaseQuoteError
        ? `Atomic rebalance needs simulated close token amounts: ${closeState.decreaseQuoteError}`
        : "Atomic rebalance needs simulated close token amounts."
    };
  }

  let available0 = closeState.decreaseAmount0 + closeState.tokensOwed0;
  let available1 = closeState.decreaseAmount1 + closeState.tokensOwed1;
  const amountIn = BigInt(swapIntent.amountInRaw);
  const minAmountOut = BigInt(swapIntent.minAmountOutRaw ?? 0);
  const tokenIn = getAddress(swapIntent.tokenInAddress);
  const tokenOut = getAddress(swapIntent.tokenOutAddress);
  const weth = getAddress(CONTRACTS.weth);
  const usdc = getAddress(CONTRACTS.usdc);

  if (tokenIn === weth && tokenOut === usdc) {
    if (available0 < amountIn) {
      return {
        status: "blocked" as const,
        reason: `Atomic rebalance swap needs ${amountIn.toString()} WETH raw, but close simulation provides ${available0.toString()}.`
      };
    }
    available0 -= amountIn;
    available1 += minAmountOut;
  } else if (tokenIn === usdc && tokenOut === weth) {
    if (available1 < amountIn) {
      return {
        status: "blocked" as const,
        reason: `Atomic rebalance swap needs ${amountIn.toString()} USDC raw, but close simulation provides ${available1.toString()}.`
      };
    }
    available1 -= amountIn;
    available0 += minAmountOut;
  } else {
    return {
      status: "blocked" as const,
      reason: "Atomic rebalance only supports WETH/USDC swap directions."
    };
  }

  const capped = scaleMintAmountsToBalances(desired, available0, available1);
  if (!capped) {
    return {
      status: "blocked" as const,
      reason: "Atomic rebalance has no conservative post-swap balance available for minting."
    };
  }

  return {
    status: "ready" as const,
    amounts: capped,
    capped: capped.amount0 !== desired.amount0 || capped.amount1 !== desired.amount1,
    available0,
    available1
  };
}

function buildRebalancerRoleChecks(intents: TransactionIntent[], options: BuildExecutionOptions = {}) {
  const needsAtomicRebalancer =
    intents.some((intent) => intent.kind === "close_position") &&
    intents.some((intent) => intent.kind === "swap_exact_input") &&
    intents.some((intent) => intent.kind === "mint_position");
  if (!needsAtomicRebalancer) return [];

  const configuredRebalancer = options.rebalancerAddress ?? getConfig().AUTOPILOT_REBALANCER_ADDRESS;
  if (!configuredRebalancer) return [];

  const roles = options.rebalancerRoles;
  if (!roles) {
    return [
      {
        label: "Rebalancer roles",
        ok: false,
        detail: "Rebalancer roles were not checked"
      }
    ];
  }

  return [
    {
      label: "Rebalancer roles",
      ok: roles.status === "roles_match",
      detail: roles.detail
    }
  ];
}

function buildSwapSourceChecks(intents: TransactionIntent[], preview: AutopilotExecutionPreview) {
  return intents
    .filter((intent): intent is Extract<TransactionIntent, { kind: "swap_exact_input" }> => intent.kind === "swap_exact_input")
    .map((intent) => {
      const routeGas = intent.gasEstimate ? BigInt(intent.gasEstimate) : 0n;
      const routeTooComplex =
        preview.strategy.preset === "small_capital_test" &&
        intent.sourceType === "zeroex_allowance_holder" &&
        routeGas > SMALL_CAPITAL_MAX_ZEROEX_ROUTE_GAS;
      const executableSource = (intent.sourceType === "uniswap_v3" || intent.sourceType === "zeroex_allowance_holder") && intent.executable;
      return {
        label: "Swap source",
        ok: executableSource && !routeTooComplex,
        detail: routeTooComplex
          ? `${intent.target} route gas estimate ${routeGas.toString()} exceeds small-capital limit ${SMALL_CAPITAL_MAX_ZEROEX_ROUTE_GAS.toString()}; retry later or use a simpler route.`
          : executableSource
            ? `${intent.target} is executable by the deployed rebalancer`
            : (intent.executionNote ?? `${intent.target} is not executable by the deployed rebalancer`)
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
    "Atomic rebalancer",
    `${statusIcon(execution.atomicCall.status === "prepared")} ${execution.atomicCall.functionName} @ ${execution.atomicCall.target}${execution.atomicCall.dataPreview ? ` | ${execution.atomicCall.dataPreview}` : ""} - ${execution.atomicCall.reason}`,
    "",
    "eth_call simulation",
    ...execution.calls.map((call) => `${call.simulation.status.toUpperCase()} ${call.intent}: ${call.simulation.detail}`),
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
  const approvalChecks = buildApprovalChecks(intents, options);
  const rebalancerRoleChecks = buildRebalancerRoleChecks(intents, options);
  const swapSourceChecks = buildSwapSourceChecks(intents, preview);
  const calls = buildCalls(intents, {
    ...options,
    pool: options.pool ?? preview.pool
  });
  const atomicCall = buildAtomicRebalanceCall(intents, {
    ...options,
    pool: options.pool ?? preview.pool
  });
  const executionWithoutTelegram = {
    planId: preview.planId,
    status: [...checks, ...approvalChecks, ...rebalancerRoleChecks, ...swapSourceChecks].every((check) => check.ok) ? ("validated" as const) : ("blocked" as const),
    checks: [...checks, ...approvalChecks, ...rebalancerRoleChecks, ...swapSourceChecks],
    operations,
    intents,
    calls,
    atomicCall
  };

  return {
    ...executionWithoutTelegram,
    telegramSummary: buildTelegramSummary(executionWithoutTelegram)
  };
}

async function fetchClosePositionState(tokenId: string): Promise<ClosePositionState> {
  try {
    const client = createBaseClient();
    const position = await client.readContract({
      address: CONTRACTS.nonfungiblePositionManager,
      abi: positionManagerAbi,
      functionName: "positions",
      args: [BigInt(tokenId)]
    });
    let decreaseAmount0: bigint | undefined;
    let decreaseAmount1: bigint | undefined;
    let decreaseQuoteError: string | undefined;
    const rebalancerAddress = getConfig().AUTOPILOT_REBALANCER_ADDRESS;
    if (rebalancerAddress && position[7] > 0n) {
      try {
        const simulated = await client.simulateContract({
          account: getAddress(rebalancerAddress),
          address: CONTRACTS.nonfungiblePositionManager,
          abi: positionManagerAbi,
          functionName: "decreaseLiquidity",
          args: [
            {
              tokenId: BigInt(tokenId),
              liquidity: position[7],
              amount0Min: 0n,
              amount1Min: 0n,
              deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
            }
          ]
        });
        decreaseAmount0 = simulated.result[0];
        decreaseAmount1 = simulated.result[1];
      } catch (error) {
        decreaseQuoteError = shortError(error);
      }
    }
    return {
      status: "available",
      tokenId,
      liquidity: position[7],
      tokensOwed0: position[10],
      tokensOwed1: position[11],
      decreaseAmount0,
      decreaseAmount1,
      decreaseQuoteError
    };
  } catch (error) {
    return {
      status: "unavailable",
      tokenId,
      reason: shortError(error)
    };
  }
}

async function fetchAllowance(token: Address) {
  return createBaseClient()
    .readContract({
      address: token,
      abi: erc20Abi,
      functionName: "allowance",
      args: [getAddress(getConfig().BASE_WALLET_ADDRESS), CONTRACTS.nonfungiblePositionManager]
    })
    .catch(() => 0n);
}

async function fetchNftApproval(tokenId: string): Promise<NftApprovalState> {
  const rebalancerAddress = getConfig().AUTOPILOT_REBALANCER_ADDRESS;
  if (!rebalancerAddress) {
    return {
      status: "unavailable",
      tokenId,
      detail: "AUTOPILOT_REBALANCER_ADDRESS is not configured"
    };
  }

  try {
    const owner = getAddress(getConfig().BASE_WALLET_ADDRESS);
    const operator = getAddress(rebalancerAddress);
    const [approved, approvedForAll] = await Promise.all([
      createBaseClient().readContract({
        address: CONTRACTS.nonfungiblePositionManager,
        abi: positionManagerAbi,
        functionName: "getApproved",
        args: [BigInt(tokenId)]
      }),
      createBaseClient().readContract({
        address: CONTRACTS.nonfungiblePositionManager,
        abi: positionManagerAbi,
        functionName: "isApprovedForAll",
        args: [owner, operator]
      })
    ]);
    const isApproved = approvedForAll || approved.toLowerCase() === operator.toLowerCase();
    return {
      status: isApproved ? "approved" : "not_approved",
      tokenId,
      detail: isApproved
        ? `Rebalancer ${operator} is approved for this NFT`
        : `Rebalancer ${operator} is not approved for position #${tokenId}`
    };
  } catch (error) {
    return {
      status: "unavailable",
      tokenId,
      detail: shortError(error)
    };
  }
}

async function fetchRebalancerRoles(): Promise<RebalancerRoleState> {
  const rebalancerAddress = getConfig().AUTOPILOT_REBALANCER_ADDRESS;
  if (!rebalancerAddress) {
    return {
      status: "unavailable",
      detail: "AUTOPILOT_REBALANCER_ADDRESS is not configured"
    };
  }

  try {
    const client = createBaseClient();
    const address = getAddress(rebalancerAddress);
    const expectedVault = getAddress(getConfig().BASE_WALLET_ADDRESS);
    const expectedExecutor = getAddress(autopilotExecutorAddress());
    const [owner, executor, vault, allowanceHolder] = await Promise.all([
      client.readContract({
        address,
        abi: autopilotRebalancerAbi,
        functionName: "owner"
      }),
      client.readContract({
        address,
        abi: autopilotRebalancerAbi,
        functionName: "executor"
      }),
      client.readContract({
        address,
        abi: autopilotRebalancerAbi,
        functionName: "vault"
      }),
      client.readContract({
        address,
        abi: autopilotRebalancerAbi,
        functionName: "allowanceHolder"
      })
    ]);
    const executorMatches = executor.toLowerCase() === expectedExecutor.toLowerCase();
    const vaultMatches = vault.toLowerCase() === expectedVault.toLowerCase();
    const allowanceHolderMatches = allowanceHolder.toLowerCase() === CONTRACTS.zeroExAllowanceHolder.toLowerCase();
    return {
      status: executorMatches && vaultMatches && allowanceHolderMatches ? "roles_match" : "roles_mismatch",
      detail:
        executorMatches && vaultMatches && allowanceHolderMatches
          ? `Rebalancer owner ${owner}; executor ${executor} matches AUTOPILOT_EXECUTOR_ADDRESS; vault ${vault} matches BASE_WALLET_ADDRESS; 0x AllowanceHolder ${allowanceHolder} is allowlisted`
          : `Rebalancer owner ${owner}; executor ${executor} ${executorMatches ? "matches" : `does not match`} AUTOPILOT_EXECUTOR_ADDRESS ${expectedExecutor}; vault ${vault} ${vaultMatches ? "matches" : `does not match`} BASE_WALLET_ADDRESS ${expectedVault}; 0x AllowanceHolder ${allowanceHolder} ${allowanceHolderMatches ? "matches" : "does not match"} ${CONTRACTS.zeroExAllowanceHolder}`
    };
  } catch (error) {
    return {
      status: "unavailable",
      detail: shortError(error)
    };
  }
}

function shouldSimulateIndependentCall(call: ExecutionCall) {
  return call.status === "prepared" && (call.functionName === "decreaseLiquidity" || call.functionName === "collect");
}

async function simulatePreparedCalls(calls: ExecutionCall[]) {
  const client = createBaseClient();
  const account = getAddress(getConfig().BASE_WALLET_ADDRESS);

  return Promise.all(
    calls.map(async (call) => {
      if (call.status !== "prepared" || !call.data) {
        return {
          ...call,
          simulation: simulation("skipped", call.simulation.detail)
        };
      }

      if (!shouldSimulateIndependentCall(call)) {
        return {
          ...call,
          simulation: simulation("skipped", "Skipped to avoid a false negative; this call depends on prior transaction effects.")
        };
      }

      try {
        await client.call({
          account,
          to: getAddress(call.target),
          data: call.data
        });
        return {
          ...call,
          simulation: simulation("simulated", "eth_call succeeded against current chain state.")
        };
      } catch (error) {
        return {
          ...call,
          simulation: simulation("failed", shortError(error))
        };
      }
    })
  );
}

export async function createAutopilotDryRunExecution(planId: string) {
  const preview = await createAutopilotExecutionPreview(planId);
  const closeTokenIds = preview.steps.filter((step) => step.type === "close" && step.tokenId).map((step) => step.tokenId as string);
  const [closeStates, nftApprovals, rebalancerRoles, wethAllowance, usdcAllowance] = await Promise.all([
    Promise.all(closeTokenIds.map((tokenId) => fetchClosePositionState(tokenId))),
    Promise.all(closeTokenIds.map((tokenId) => fetchNftApproval(tokenId))),
    fetchRebalancerRoles(),
    fetchAllowance(CONTRACTS.weth),
    fetchAllowance(CONTRACTS.usdc)
  ]);
  const execution = buildAutopilotDryRunExecution(preview, {
    closePositions: Object.fromEntries(closeStates.map((state) => [state.tokenId, state])),
    nftApprovals: Object.fromEntries(nftApprovals.map((state) => [state.tokenId, state])),
    rebalancerRoles,
    allowances: {
      [allowanceKey(CONTRACTS.weth)]: wethAllowance,
      [allowanceKey(CONTRACTS.usdc)]: usdcAllowance
    }
  });
  const calls = await simulatePreparedCalls(execution.calls);
  const simulationFailed = calls.some((call) => call.simulation.status === "failed");
  const executionWithSimulation = {
    ...execution,
    status: execution.status === "validated" && simulationFailed ? ("blocked" as const) : execution.status,
    checks: simulationFailed
      ? [
          ...execution.checks,
          {
            label: "eth_call simulation",
            ok: false,
            detail: "At least one independent prepared call failed simulation"
          }
        ]
      : execution.checks,
    calls
  };

  return {
    ...executionWithSimulation,
    telegramSummary: buildTelegramSummary(executionWithSimulation)
  };
}
