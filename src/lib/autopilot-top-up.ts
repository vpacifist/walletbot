import { PositionStatus } from "@/generated/prisma/client";
import type { Telegraf } from "telegraf";
import { encodeFunctionData, formatUnits, getAddress, type Address, type Hex } from "viem";
import { erc20Abi, factoryAbi, poolAbi, positionManagerAbi } from "./abi";
import { autopilotPlanKey, getCurrentAutopilotPlan } from "./autopilot-service";
import { createBaseClient, createBaseWalletClient } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS, TOKEN_META } from "./constants";
import { prisma } from "./db";
import { formatNumber, shortAddress } from "./format";
import { priceFromTick, WETH_USDC_NARROW_FEE } from "./narrow-range-rebalance";
import { getLiquidityForAmounts, getTokenAmountsForLiquidity } from "./uniswap-v3-position";

const GAS_BUFFER_BPS = 13_000n;
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const AUTOPILOT_EXECUTION_MODES = ["auto_guarded", "approve_in_telegram", "auto_full"];

type TopUpPayload = {
  kind: "top_up";
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  priceUsd: number;
  token0: Address;
  token1: Address;
  walletWethRaw: string;
  walletUsdcRaw: string;
  amount0DesiredRaw: string;
  amount1DesiredRaw: string;
  amount0MinRaw: string;
  amount1MinRaw: string;
  wethDesired: number;
  usdcDesired: number;
  valueUsd: number;
  walletValueUsd: number;
  efficiencyBps: number;
  boundaryDistanceTicks: number;
  leftoverWeth: number;
  leftoverUsdc: number;
};

type TopUpBuildResult =
  | { status: "ready"; payload: TopUpPayload; summary: string; planKey: string }
  | { status: "skipped"; reason: string; detail?: string };

function tokenMeta(address: string) {
  const meta = TOKEN_META[address.toLowerCase()];
  if (!meta) throw new Error(`Unsupported token ${address}`);
  return meta;
}

function rawToNumber(address: string, value: bigint) {
  return Number(formatUnits(value, tokenMeta(address).decimals));
}

function formatUsd(value: number) {
  return `$${formatNumber(value, 2)}`;
}

function formatToken(value: number, symbol: string) {
  const digits = symbol === "WETH" ? 6 : 2;
  return `${formatNumber(value, digits)} ${symbol}`;
}

function isWeth(address: string) {
  return getAddress(address) === getAddress(CONTRACTS.weth);
}

function getAmountByToken(token0: string, token1: string, amounts: { amount0: bigint; amount1: bigint }, token: Address) {
  if (getAddress(token0) === token) return amounts.amount0;
  if (getAddress(token1) === token) return amounts.amount1;
  return 0n;
}

function currentPriceUsd(currentTick: number, token0: Address, token1: Address) {
  const price = priceFromTick({
    tick: currentTick,
    token0,
    token1,
    baseToken: CONTRACTS.weth,
    quoteToken: CONTRACTS.usdc
  });
  if (!price || !Number.isFinite(price) || price <= 0) throw new Error("Unable to calculate WETH/USDC price.");
  return price;
}

async function readTopUpPoolTick() {
  const client = createBaseClient();
  const poolAddress = await client.readContract({
    address: CONTRACTS.uniswapV3Factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [CONTRACTS.weth, CONTRACTS.usdc, WETH_USDC_NARROW_FEE]
  });
  if (poolAddress === ZERO_ADDRESS) throw new Error("WETH/USDC 0.3% pool not found");

  const slot0 = await client.readContract({
    address: poolAddress,
    abi: poolAbi,
    functionName: "slot0"
  });
  return Number(slot0[1]);
}

async function hasActiveAutopilotExecution() {
  const executing = await prisma.rebalancePlan.findFirst({
    where: {
      status: "executing",
      mode: { in: AUTOPILOT_EXECUTION_MODES }
    },
    orderBy: { updatedAt: "desc" }
  });
  if (executing) return true;

  const approved = await prisma.rebalancePlan.findMany({
    where: {
      status: "approved",
      mode: { in: AUTOPILOT_EXECUTION_MODES }
    },
    orderBy: { updatedAt: "desc" },
    take: 10,
    select: { planKey: true }
  });
  if (approved.length === 0) return false;

  try {
    const current = await getCurrentAutopilotPlan();
    if (current.state === "idle" || current.state === "paused" || current.state === "cooldown") return false;
    if (!current.actions.some((action) => action.type !== "hold" && action.type !== "wait")) return false;

    const currentPlanKey = autopilotPlanKey(current);
    return approved.some((plan) => plan.planKey === currentPlanKey);
  } catch {
    return true;
  }
}

async function hasRecentTopUp(tokenId: string) {
  const since = new Date(Date.now() - getConfig().AUTOPILOT_TOP_UP_COOLDOWN_HOURS * 60 * 60 * 1000);
  const existing = await prisma.rebalancePlan.findFirst({
    where: {
      mode: "top_up",
      status: { in: ["pending", "approved", "executing", "completed"] },
      createdAt: { gte: since },
      payload: {
        path: ["tokenId"],
        equals: tokenId
      }
    },
    orderBy: { createdAt: "desc" }
  });
  return Boolean(existing);
}

export async function buildTopUpPlan(options: { force?: boolean; currentTick?: number; minEfficiencyBps?: number; minBoundaryDistanceTicks?: number } = {}): Promise<TopUpBuildResult> {
  const config = getConfig();
  if (!config.AUTOPILOT_TOP_UP_ENABLED && !options.force) return { status: "skipped", reason: "top_up_disabled" };
  if (!config.BASE_WALLET_PRIVATE_KEY) return { status: "skipped", reason: "base_wallet_private_key_missing" };
  if (!options.force && (await hasActiveAutopilotExecution())) return { status: "skipped", reason: "autopilot_execution_active" };

  const wallet = await prisma.wallet.findUnique({ where: { address: getAddress(config.BASE_WALLET_ADDRESS) } });
  if (!wallet) return { status: "skipped", reason: "wallet_not_found" };

  const position = await prisma.position.findFirst({
    where: {
      walletId: wallet.id,
      fee: 3000,
      status: PositionStatus.in_range,
      liquidity: { not: "0" },
      currentTick: { not: null }
    },
    orderBy: [{ tokenId: "desc" }, { updatedAt: "desc" }]
  });
  if (!position || position.currentTick === null) return { status: "skipped", reason: "no_in_range_position" };
  if (!options.force && (await hasRecentTopUp(position.tokenId))) return { status: "skipped", reason: "top_up_cooldown", detail: `Position #${position.tokenId}` };

  const currentTick = options.currentTick ?? position.currentTick;
  if (currentTick < position.tickLower || currentTick >= position.tickUpper) {
    return { status: "skipped", reason: "not_in_range_at_live_tick", detail: `Tick ${currentTick}; range ${position.tickLower} - ${position.tickUpper}` };
  }
  const boundaryDistanceTicks = Math.min(currentTick - position.tickLower, position.tickUpper - currentTick - 1);
  const minBoundaryDistanceTicks = options.minBoundaryDistanceTicks ?? 0;
  if (boundaryDistanceTicks < minBoundaryDistanceTicks) {
    return {
      status: "skipped",
      reason: "too_close_to_boundary",
      detail: `${boundaryDistanceTicks} ticks < ${minBoundaryDistanceTicks}`
    };
  }

  const token0 = getAddress(position.token0);
  const token1 = getAddress(position.token1);
  if (![token0, token1].some((token) => token === getAddress(CONTRACTS.weth)) || ![token0, token1].some((token) => token === getAddress(CONTRACTS.usdc))) {
    return { status: "skipped", reason: "unsupported_position_pair" };
  }

  const client = createBaseClient();
  const walletAddress = getAddress(config.BASE_WALLET_ADDRESS);
  const [walletWethRaw, walletUsdcRaw] = await Promise.all([
    client.readContract({ address: CONTRACTS.weth, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] }),
    client.readContract({ address: CONTRACTS.usdc, abi: erc20Abi, functionName: "balanceOf", args: [walletAddress] })
  ]);
  const amount0Available = isWeth(token0) ? walletWethRaw : walletUsdcRaw;
  const amount1Available = isWeth(token1) ? walletWethRaw : walletUsdcRaw;
  const liquidity = getLiquidityForAmounts({
    amount0: amount0Available,
    amount1: amount1Available,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentTick
  });
  if (liquidity <= 0n) return { status: "skipped", reason: "insufficient_balanced_leftovers" };

  const desired = getTokenAmountsForLiquidity({
    liquidity,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentTick
  });
  if (desired.amount0 <= 0n && desired.amount1 <= 0n) return { status: "skipped", reason: "zero_top_up_amount" };

  const wethDesiredRaw = getAmountByToken(token0, token1, desired, getAddress(CONTRACTS.weth));
  const usdcDesiredRaw = getAmountByToken(token0, token1, desired, getAddress(CONTRACTS.usdc));
  const priceUsd = currentPriceUsd(currentTick, token0, token1);
  const wethDesired = rawToNumber(CONTRACTS.weth, wethDesiredRaw);
  const usdcDesired = rawToNumber(CONTRACTS.usdc, usdcDesiredRaw);
  const valueUsd = wethDesired * priceUsd + usdcDesired;
  if (valueUsd < config.AUTOPILOT_TOP_UP_MIN_USD) {
    return { status: "skipped", reason: "below_minimum_value", detail: `${formatUsd(valueUsd)} < ${formatUsd(config.AUTOPILOT_TOP_UP_MIN_USD)}` };
  }

  const leftoverWeth = rawToNumber(CONTRACTS.weth, walletWethRaw - wethDesiredRaw);
  const leftoverUsdc = rawToNumber(CONTRACTS.usdc, walletUsdcRaw - usdcDesiredRaw);
  const walletWeth = rawToNumber(CONTRACTS.weth, walletWethRaw);
  const walletUsdc = rawToNumber(CONTRACTS.usdc, walletUsdcRaw);
  const walletValueUsd = walletWeth * priceUsd + walletUsdc;
  const efficiencyBps = walletValueUsd > 0 ? Math.floor((valueUsd / walletValueUsd) * 10_000) : 0;
  const minEfficiencyBps = options.minEfficiencyBps ?? 0;
  if (efficiencyBps < minEfficiencyBps) {
    return {
      status: "skipped",
      reason: "top_up_efficiency_below_threshold",
      detail: `${(efficiencyBps / 100).toFixed(2)}% < ${(minEfficiencyBps / 100).toFixed(2)}%`
    };
  }
  // Top-up does not swap. Zero minimums avoid stale-tick reverts; unused tokens stay in the wallet.
  const amount0Min = 0n;
  const amount1Min = 0n;
  const payload: TopUpPayload = {
    kind: "top_up",
    tokenId: position.tokenId,
    tickLower: position.tickLower,
    tickUpper: position.tickUpper,
    currentTick,
    priceUsd,
    token0,
    token1,
    walletWethRaw: walletWethRaw.toString(),
    walletUsdcRaw: walletUsdcRaw.toString(),
    amount0DesiredRaw: desired.amount0.toString(),
    amount1DesiredRaw: desired.amount1.toString(),
    amount0MinRaw: amount0Min.toString(),
    amount1MinRaw: amount1Min.toString(),
    wethDesired,
    usdcDesired,
    valueUsd,
    walletValueUsd,
    efficiencyBps,
    boundaryDistanceTicks,
    leftoverWeth,
    leftoverUsdc
  };

  const summary = [
    "Top up current range",
    `Position #${payload.tokenId}`,
    `Range ${payload.tickLower} - ${payload.tickUpper} | Tick ${payload.currentTick}`,
    `Add ${formatToken(payload.wethDesired, "WETH")} + ${formatToken(payload.usdcDesired, "USDC")} (${formatUsd(payload.valueUsd)})`,
    `Efficiency: ${(payload.efficiencyBps / 100).toFixed(2)}% of ${formatUsd(payload.walletValueUsd)} wallet leftovers`,
    `Boundary distance: ${payload.boundaryDistanceTicks} ticks`,
    `Wallet leftover after top-up: ${formatToken(payload.leftoverWeth, "WETH")} + ${formatToken(payload.leftoverUsdc, "USDC")}`,
    "Swap: none; only the already balanced wallet part is added.",
    "Mode: review in Telegram"
  ].join("\n");

  const planKey = [
    "top-up",
    payload.tokenId,
    payload.currentTick,
    payload.efficiencyBps,
    payload.amount0DesiredRaw,
    payload.amount1DesiredRaw,
    payload.walletWethRaw,
    payload.walletUsdcRaw
  ].join(":");

  return { status: "ready", payload, summary, planKey };
}

export async function createTopUpPlan(options: { telegramChatId?: string; force?: boolean; currentTick?: number; minEfficiencyBps?: number; minBoundaryDistanceTicks?: number } = {}) {
  const built = await buildTopUpPlan({
    force: options.force,
    currentTick: options.currentTick,
    minEfficiencyBps: options.minEfficiencyBps,
    minBoundaryDistanceTicks: options.minBoundaryDistanceTicks
  });
  if (built.status === "skipped") return built;

  const existing = await prisma.rebalancePlan.findFirst({
    where: {
      planKey: built.planKey,
      status: { in: ["pending", "approved", "executing"] }
    },
    orderBy: { createdAt: "desc" }
  });
  if (existing) {
    return {
      status: "ready" as const,
      payload: built.payload,
      summary: built.summary,
      record: existing
    };
  }

  const record = await prisma.rebalancePlan.create({
    data: {
      planKey: built.planKey,
      status: "pending",
      mode: "top_up",
      state: "ready",
      title: "Top up current range",
      summary: built.summary,
      payload: built.payload,
      telegramChatId: options.telegramChatId
    }
  });
  return {
    status: "ready" as const,
    payload: built.payload,
    summary: built.summary,
    record
  };
}

function assertTopUpPayload(payload: unknown): TopUpPayload {
  if (!payload || typeof payload !== "object" || (payload as { kind?: unknown }).kind !== "top_up") {
    throw new Error("Top-up plan payload is invalid.");
  }
  return payload as TopUpPayload;
}

async function refreshTopUpPlanForExecution(planId: string) {
  const record = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
  if (!record) throw new Error(`Top-up plan #${planId} not found.`);
  const previousPayload = assertTopUpPayload(record.payload);
  const currentTick = await readTopUpPoolTick();
  const fresh = await buildTopUpPlan({ force: true, currentTick });
  if (fresh.status === "skipped") {
    throw new Error(`Fresh top-up unavailable: ${fresh.reason}${fresh.detail ? ` (${fresh.detail})` : ""}.`);
  }
  if (fresh.payload.tokenId !== previousPayload.tokenId) {
    throw new Error(`Fresh top-up points to position #${fresh.payload.tokenId}, but approved plan was for #${previousPayload.tokenId}.`);
  }

  return prisma.rebalancePlan.update({
    where: { id: planId },
    data: {
      summary: fresh.summary,
      payload: fresh.payload,
      decisionNote: `Top-up execution refreshed at live tick ${currentTick}.`
    }
  });
}

export function topUpReviewKeyboard(planId: string) {
  return {
    inline_keyboard: [
      [{ text: "Approve top-up", callback_data: `tu:approve:${planId}` }],
      [{ text: "Skip", callback_data: `tu:skip:${planId}` }]
    ]
  };
}

export function topUpExecuteKeyboard(planId: string) {
  const config = getConfig();
  if (!config.AUTOPILOT_LIVE_EXECUTION_ENABLED || !config.BASE_WALLET_PRIVATE_KEY) return undefined;
  return {
    inline_keyboard: [[{ text: "Confirm top-up transaction", callback_data: `tu:execute:${planId}` }]]
  };
}

export async function approveTopUpPlan(planId: string) {
  return prisma.rebalancePlan.update({
    where: { id: planId },
    data: {
      status: "approved",
      decidedAt: new Date(),
      decisionNote: "Top-up approved in Telegram."
    }
  });
}

export async function skipTopUpPlan(planId: string) {
  return prisma.rebalancePlan.update({
    where: { id: planId },
    data: {
      status: "skipped",
      decidedAt: new Date(),
      decisionNote: "Top-up skipped in Telegram."
    }
  });
}

export async function createTopUpExecutionPreview(planId: string) {
  const record = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
  if (!record) throw new Error(`Top-up plan #${planId} not found.`);
  const payload = assertTopUpPayload(record.payload);
  const amount0 = BigInt(payload.amount0DesiredRaw);
  const amount1 = BigInt(payload.amount1DesiredRaw);
  const amount0Min = BigInt(payload.amount0MinRaw);
  const amount1Min = BigInt(payload.amount1MinRaw);
  const wallet = getAddress(getConfig().BASE_WALLET_ADDRESS);
  const client = createBaseClient();
  const [allowance0, allowance1] = await Promise.all([
    client.readContract({ address: payload.token0, abi: erc20Abi, functionName: "allowance", args: [wallet, CONTRACTS.nonfungiblePositionManager] }),
    client.readContract({ address: payload.token1, abi: erc20Abi, functionName: "allowance", args: [wallet, CONTRACTS.nonfungiblePositionManager] })
  ]);
  const needsToken0 = allowance0 < amount0;
  const needsToken1 = allowance1 < amount1;
  const token0Symbol = isWeth(payload.token0) ? "WETH" : "USDC";
  const token1Symbol = isWeth(payload.token1) ? "WETH" : "USDC";
  const data = encodeFunctionData({
    abi: positionManagerAbi,
    functionName: "increaseLiquidity",
    args: [
      {
        tokenId: BigInt(payload.tokenId),
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min,
        amount1Min,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
      }
    ]
  });

  return {
    status: "ready" as const,
    record,
    payload,
    checks: [
      { label: "Plan status", ok: record.status === "approved", detail: `status ${record.status}` },
      { label: `${token0Symbol} allowance`, ok: !needsToken0, detail: needsToken0 ? "approval transaction will be sent first" : "ok" },
      { label: `${token1Symbol} allowance`, ok: !needsToken1, detail: needsToken1 ? "approval transaction will be sent first" : "ok" }
    ],
    data,
    summary: [
      "Top-up execution preview",
      `Plan id: ${record.id}`,
      `Status: ${record.status === "approved" ? "ready" : "blocked"}`,
      "",
      `Position #${payload.tokenId}`,
      `Add ${formatToken(payload.wethDesired, "WETH")} + ${formatToken(payload.usdcDesired, "USDC")} (${formatUsd(payload.valueUsd)})`,
      `Efficiency: ${(payload.efficiencyBps / 100).toFixed(2)}% of ${formatUsd(payload.walletValueUsd)} wallet leftovers`,
      `Boundary distance: ${payload.boundaryDistanceTicks} ticks`,
      "Swap: none; this only increases liquidity with the balanced wallet part.",
      needsToken0 || needsToken1 ? "Approvals: required before increaseLiquidity." : "Approvals: already sufficient.",
      "",
      "No on-chain transactions were sent."
    ].join("\n")
  };
}

function gasCostUsd(gas: bigint, gasPriceWei: bigint, ethUsd: number) {
  return (Number(gas * gasPriceWei) / 1e18) * ethUsd;
}

function bufferedGas(estimated: bigint) {
  return (estimated * GAS_BUFFER_BPS) / 10_000n;
}

async function approveIfNeeded(input: {
  token: Address;
  spender: Address;
  amount: bigint;
  owner: Address;
  label: string;
}) {
  const client = createBaseClient();
  const walletClient = createBaseWalletClient();
  const allowance = await client.readContract({
    address: input.token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [input.owner, input.spender]
  });
  if (allowance >= input.amount) return null;

  const data = encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [input.spender, input.amount]
  });
  const gas = bufferedGas(
    await client.estimateGas({
      account: walletClient.account.address,
      to: input.token,
      data
    })
  );
  const hash = await walletClient.sendTransaction({
    account: walletClient.account,
    chain: walletClient.chain,
    to: input.token,
    data,
    gas
  });
  const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
  if (receipt.status !== "success") throw new Error(`${input.label} approval reverted. Tx Hash: ${hash}`);
  return hash;
}

function conciseError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const firstLine = message.split("\n").find((line) => line.trim()) ?? message;
  return firstLine.length > 700 ? `${firstLine.slice(0, 697)}...` : firstLine;
}

export async function broadcastTopUp(planId: string) {
  if (!getConfig().AUTOPILOT_LIVE_EXECUTION_ENABLED) {
    return { success: false as const, error: "Live execution is disabled. Set AUTOPILOT_LIVE_EXECUTION_ENABLED=true to enable it." };
  }

  const locked = await prisma.rebalancePlan.updateMany({
    where: { id: planId, status: "approved", mode: "top_up" },
    data: {
      status: "executing",
      decisionNote: "Initiating top-up transaction execution..."
    }
  });
  if (locked.count !== 1) {
    const record = await prisma.rebalancePlan.findUnique({ where: { id: planId } });
    return { success: false as const, error: record ? `Plan status is ${record.status}; top-up execution requires an approved plan.` : `Top-up plan #${planId} not found.` };
  }

  try {
    await refreshTopUpPlanForExecution(planId);
    const preview = await createTopUpExecutionPreview(planId);
    const payload = preview.payload;
    const amount0 = BigInt(payload.amount0DesiredRaw);
    const amount1 = BigInt(payload.amount1DesiredRaw);
    const wallet = createBaseWalletClient();
    const client = createBaseClient();
    const owner = getAddress(getConfig().BASE_WALLET_ADDRESS);

    const approvalHashes = (
      await Promise.all([
        approveIfNeeded({
          token: payload.token0,
          spender: CONTRACTS.nonfungiblePositionManager,
          amount: amount0,
          owner,
          label: isWeth(payload.token0) ? "WETH" : "USDC"
        }),
        approveIfNeeded({
          token: payload.token1,
          spender: CONTRACTS.nonfungiblePositionManager,
          amount: amount1,
          owner,
          label: isWeth(payload.token1) ? "WETH" : "USDC"
        })
      ])
    ).filter(Boolean) as Hex[];

    const data = encodeFunctionData({
      abi: positionManagerAbi,
      functionName: "increaseLiquidity",
      args: [
        {
          tokenId: BigInt(payload.tokenId),
          amount0Desired: amount0,
          amount1Desired: amount1,
          amount0Min: BigInt(payload.amount0MinRaw),
          amount1Min: BigInt(payload.amount1MinRaw),
          deadline: BigInt(Math.floor(Date.now() / 1000) + 120)
        }
      ]
    });

    await client.call({
      account: wallet.account.address,
      to: CONTRACTS.nonfungiblePositionManager,
      data
    });
    const estimatedGas = await client.estimateGas({
      account: wallet.account.address,
      to: CONTRACTS.nonfungiblePositionManager,
      data
    });
    const gas = bufferedGas(estimatedGas);
    const [gasPriceWei] = await Promise.all([client.getGasPrice()]);
    const estimatedCostUsd = gasCostUsd(gas, gasPriceWei, payload.priceUsd);
    if (estimatedCostUsd > getConfig().AUTOPILOT_MAX_GAS_COST_USD) {
      throw new Error(`Top-up gas cost is too high: estimated ${formatUsd(estimatedCostUsd)}, cap ${formatUsd(getConfig().AUTOPILOT_MAX_GAS_COST_USD)}.`);
    }

    const hash = await wallet.sendTransaction({
      account: wallet.account,
      chain: wallet.chain,
      to: CONTRACTS.nonfungiblePositionManager,
      data,
      gas
    });
    const receipt = await client.waitForTransactionReceipt({ hash, confirmations: 1, timeout: 60_000 });
    if (receipt.status !== "success") throw new Error(`Top-up transaction reverted. Tx Hash: ${hash}`);

    await prisma.rebalancePlan.update({
      where: { id: planId },
      data: {
        status: "completed",
        decidedAt: new Date(),
        decisionNote: `Successfully executed top-up. Tx Hash: ${hash}${approvalHashes.length ? `; approvals: ${approvalHashes.map(shortAddress).join(", ")}` : ""}`
      }
    });
    return { success: true as const, txHash: hash, approvalHashes };
  } catch (error) {
    const message = conciseError(error);
    await prisma.rebalancePlan.update({
      where: { id: planId },
      data: {
        status: "failed",
        decidedAt: new Date(),
        decisionNote: `Top-up execution failed: ${message}`
      }
    });
    return { success: false as const, error: message };
  }
}

export async function sendTopUpAlert(bot: Telegraf) {
  const chatId = getConfig().TELEGRAM_CHAT_ID;
  if (!chatId) return { sent: 0, skipped: "telegram_not_configured" };

  const config = getConfig();
  const plan = await createTopUpPlan({
    telegramChatId: chatId,
    minEfficiencyBps: config.AUTOPILOT_TOP_UP_MIN_EFFICIENCY_BPS,
    minBoundaryDistanceTicks: config.AUTOPILOT_TOP_UP_MIN_BOUNDARY_DISTANCE_TICKS
  });
  if (plan.status === "skipped") return { sent: 0, skipped: plan.reason, detail: plan.detail };
  const existingEvent = await prisma.telegramEvent.findUnique({ where: { dedupeKey: `top-up-alert:${plan.record.id}` } });
  if (existingEvent) return { sent: 0, skipped: "duplicate_top_up_alert" };

  const message = await bot.telegram.sendMessage(chatId, [plan.summary, "", `Plan id: ${plan.record.id}`].join("\n"), {
    reply_markup: topUpReviewKeyboard(plan.record.id)
  });
  await prisma.rebalancePlan.update({
    where: { id: plan.record.id },
    data: {
      telegramChatId: chatId,
      telegramMessageId: String((message as { message_id?: unknown }).message_id ?? "")
    }
  });
  await prisma.telegramEvent.create({
    data: {
      alertType: "top_up_plan",
      dedupeKey: `top-up-alert:${plan.record.id}`,
      payload: {
        planId: plan.record.id,
        tokenId: plan.payload.tokenId,
        valueUsd: plan.payload.valueUsd
      }
    }
  });
  return { sent: 1, planId: plan.record.id };
}

export async function sendTopUpOpportunityAlert(bot: Telegraf, currentTick: number) {
  const config = getConfig();
  const chatId = config.TELEGRAM_CHAT_ID;
  if (!chatId) return { sent: 0, skipped: "telegram_not_configured" };
  if (!config.AUTOPILOT_TOP_UP_ENABLED) return { sent: 0, skipped: "top_up_disabled" };

  const plan = await createTopUpPlan({
    telegramChatId: chatId,
    currentTick,
    minEfficiencyBps: config.AUTOPILOT_TOP_UP_MIN_EFFICIENCY_BPS,
    minBoundaryDistanceTicks: config.AUTOPILOT_TOP_UP_MIN_BOUNDARY_DISTANCE_TICKS
  });
  if (plan.status === "skipped") return { sent: 0, skipped: plan.reason, detail: plan.detail };

  const dedupeKey = `top-up-opportunity:${plan.payload.tokenId}:${plan.payload.walletWethRaw}:${plan.payload.walletUsdcRaw}`;
  const existingEvent = await prisma.telegramEvent.findUnique({ where: { dedupeKey } });
  if (existingEvent) return { sent: 0, skipped: "duplicate_top_up_opportunity" };

  const message = await bot.telegram.sendMessage(
    chatId,
    [
      "Good top-up moment",
      plan.summary,
      "",
      `Plan id: ${plan.record.id}`
    ].join("\n"),
    {
      reply_markup: topUpReviewKeyboard(plan.record.id)
    }
  );
  await prisma.rebalancePlan.update({
    where: { id: plan.record.id },
    data: {
      telegramChatId: chatId,
      telegramMessageId: String(message.message_id)
    }
  });
  await prisma.telegramEvent.create({
    data: {
      alertType: "top_up_opportunity",
      dedupeKey,
      payload: {
        planId: plan.record.id,
        tokenId: plan.payload.tokenId,
        valueUsd: plan.payload.valueUsd,
        walletValueUsd: plan.payload.walletValueUsd,
        efficiencyBps: plan.payload.efficiencyBps,
        currentTick: plan.payload.currentTick
      }
    }
  });
  return { sent: 1, planId: plan.record.id, efficiencyBps: plan.payload.efficiencyBps };
}
