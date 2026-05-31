import { type Position } from "@/generated/prisma/client";
import { createHash } from "node:crypto";
import { getAddress } from "viem";
import { factoryAbi, poolAbi } from "./abi";
import { calculateAutopilotPlan } from "./autopilot-plan";
import { createBaseClient } from "./chain";
import { getConfig } from "./config";
import { CONTRACTS } from "./constants";
import { prisma } from "./db";
import { WETH_USDC_NARROW_FEE } from "./narrow-range-rebalance";
import { getUncollectedPositionFees } from "./uniswap-v3-fees";
import { getWalletAssetAmountsSnapshot } from "./wallet-assets";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

function activeNarrowPosition(position: Position) {
  return position.fee === WETH_USDC_NARROW_FEE && position.status !== "closed_or_zero_liquidity" && position.currentTick !== null;
}

function latestSyncedPoolSnapshot(positions: Position[]) {
  const reference = positions
    .filter(activeNarrowPosition)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];

  if (!reference || reference.currentTick === null) return null;

  return {
    currentTick: reference.currentTick,
    token0: getAddress(reference.token0),
    token1: getAddress(reference.token1)
  };
}

function autopilotBaselineAt() {
  const value = getConfig().AUTOPILOT_BASELINE_AT;
  return value ? new Date(value) : null;
}

async function livePoolSnapshot() {
  const client = createBaseClient();
  const poolAddress = await client.readContract({
    address: CONTRACTS.uniswapV3Factory,
    abi: factoryAbi,
    functionName: "getPool",
    args: [CONTRACTS.weth, CONTRACTS.usdc, WETH_USDC_NARROW_FEE]
  });

  if (poolAddress === ZERO_ADDRESS) throw new Error("WETH/USDC 0.3% pool not found");

  const [slot0, token0, token1] = await Promise.all([
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "slot0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token0" }),
    client.readContract({ address: poolAddress, abi: poolAbi, functionName: "token1" })
  ]);

  return {
    currentTick: Number(slot0[1]),
    token0,
    token1
  };
}

export async function getCurrentAutopilotPlan() {
  const walletAddress = getAddress(getConfig().BASE_WALLET_ADDRESS);
  const walletRecord = await prisma.wallet.findUnique({ where: { address: walletAddress } });
  const [wallet, positions, transactions, livePool] = await Promise.all([
    getWalletAssetAmountsSnapshot(walletAddress).catch(() => ({ weth: null, usdc: null })),
    walletRecord
      ? prisma.position.findMany({ where: { walletId: walletRecord.id }, orderBy: [{ tokenId: "desc" }, { createdAt: "desc" }] })
      : Promise.resolve([]),
    prisma.transaction.findMany({
      where: walletRecord ? { walletId: walletRecord.id } : { walletId: "__missing_wallet__" },
      orderBy: [{ blockNumber: "desc" }, { timestamp: "desc" }],
      take: 80,
      select: {
        timestamp: true,
        hash: true,
        protocol: true,
        tokenAmounts: true,
        type: true
      }
    }),
    livePoolSnapshot().catch(() => null)
  ]);
  const pool = livePool ?? latestSyncedPoolSnapshot(positions);
  if (!pool) throw new Error("No live or synced WETH/USDC 0.3% pool tick available");

  const basePlan = calculateAutopilotPlan({
    positions,
    transactions,
    walletWeth: wallet.weth,
    walletUsdc: wallet.usdc,
    currentTick: pool.currentTick,
    token0: pool.token0,
    token1: pool.token1,
    preset: getConfig().AUTOPILOT_PRESET,
    baselineAt: autopilotBaselineAt()
  });

  if (!basePlan.economics.lastDirectionalSwap) return basePlan;

  const uncollectedFeeAmounts = await Promise.all(
    positions
      .filter(activeNarrowPosition)
      .map((position) =>
        getUncollectedPositionFees({
          tokenId: position.tokenId,
          token0: position.token0,
          token1: position.token1,
          walletAddress
        }).catch(() => ({ weth: 0, usdc: 0 }))
      )
  );
  const uncollectedFeeCreditUsd = uncollectedFeeAmounts.reduce((sum, fees) => sum + fees.weth * basePlan.pool.price + fees.usdc, 0);

  return calculateAutopilotPlan({
    positions,
    transactions,
    walletWeth: wallet.weth,
    walletUsdc: wallet.usdc,
    currentTick: pool.currentTick,
    token0: pool.token0,
    token1: pool.token1,
    preset: getConfig().AUTOPILOT_PRESET,
    baselineAt: autopilotBaselineAt(),
    uncollectedFeeCreditUsd
  });
}

function planKeyInput(plan: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>) {
  return {
    state: plan.state,
    currentTick: plan.pool.currentTick,
    baseTick: plan.pool.baseTick,
    strategy: plan.strategy,
    ladder: plan.ladder.map((segment) => ({
      role: segment.role,
      range: segment.range,
      tokenId: segment.tokenId,
      status: segment.status,
      plannedAction: segment.plannedAction
    })),
    actions: plan.actions.map((action) => ({ type: action.type, label: action.label })),
    economics: {
      immediateCostUsd: Math.round(plan.economics.immediateCostUsd * 100),
      reversalDebtUsd: Math.round(plan.economics.reversalDebtUsd * 100),
      feeCreditUsd: Math.round(plan.economics.feeCreditUsd * 100),
      uncoveredReversalDebtUsd: Math.round(plan.economics.uncoveredReversalDebtUsd * 100)
    }
  };
}

export function autopilotPlanKey(plan: Awaited<ReturnType<typeof getCurrentAutopilotPlan>>) {
  return createHash("sha256").update(JSON.stringify(planKeyInput(plan))).digest("hex");
}

export async function getOrCreatePendingAutopilotPlan(params?: { telegramChatId?: string; telegramMessageId?: string }) {
  const plan = await getCurrentAutopilotPlan();
  const planKey = autopilotPlanKey(plan);
  const existing = await prisma.rebalancePlan.findFirst({
    where: { planKey, status: "pending" },
    orderBy: { createdAt: "desc" }
  });

  if (existing) {
    if (
      (params?.telegramChatId && existing.telegramChatId !== params.telegramChatId) ||
      (params?.telegramMessageId && existing.telegramMessageId !== params.telegramMessageId)
    ) {
      const updated = await prisma.rebalancePlan.update({
        where: { id: existing.id },
        data: {
          telegramChatId: params.telegramChatId ?? existing.telegramChatId,
          telegramMessageId: params.telegramMessageId ?? existing.telegramMessageId
        }
      });
      return { plan, record: updated };
    }
    return { plan, record: existing };
  }

  const record = await prisma.rebalancePlan.create({
    data: {
      planKey,
      status: "pending",
      mode: plan.mode,
      state: plan.state,
      title: plan.title,
      summary: plan.telegramSummary,
      payload: plan,
      telegramChatId: params?.telegramChatId,
      telegramMessageId: params?.telegramMessageId
    }
  });

  return { plan, record };
}

export async function recordAutopilotPlanDecision(id: string, decision: "approved" | "skipped" | "paused") {
  const existing = await prisma.rebalancePlan.findUnique({ where: { id } });
  if (!existing) throw new Error("Rebalance plan not found");
  if (existing.status !== "pending") return existing;

  return prisma.rebalancePlan.update({
    where: { id },
    data: {
      status: decision,
      decidedAt: new Date(),
      decisionNote:
        decision === "approved"
          ? "Approved in Telegram. Executor dry-run is ready."
          : decision === "skipped"
            ? "Skipped in Telegram."
            : "Paused in Telegram."
    }
  });
}
