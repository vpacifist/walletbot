import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { formatNumber, shortAddress } from "@/lib/format";
import { readHistoricalPrices } from "@/lib/historical-prices";
import { sortPositionsForDisplay } from "@/lib/position-order";
import { getUncollectedPositionFees } from "@/lib/uniswap-v3-fees";
import { tickToWethUsdcPrice } from "@/lib/uniswap-v3-position";
import {
  addLpDelta,
  getTransactionAssetDelta,
  getTransactionLpDelta,
  getTransactionPositionExitAmounts,
  getTransactionPositionLiquidityDeltas,
  getTransactionPositionPrincipalDeltas,
  getWalletAssetAmountsSnapshotAtBlock,
  subtractDelta,
  type LpAssetAmounts,
  type WalletAssetAmounts
} from "@/lib/wallet-assets";
import { logoutAction } from "./actions";
import { AutopilotPlanLive } from "./autopilot-plan-live";
import { BrandLogo } from "./brand-logo";
import { DashboardTabs } from "./dashboard-tabs";
import { GrowthChart } from "./growth-chart";
import { SyncNowButton } from "./sync-now-button";
import { SyncStatusLive } from "./sync-status-live";
import { NarrowRangeRebalanceLive } from "./narrow-range-rebalance-live";
import { PositionsTable, type PositionTableRow } from "./positions-table";
import { TransactionsTable, type TransactionTableRow } from "./transactions-table";
import { TripleRangeGuideLive } from "./triple-range-guide-live";

export const dynamic = "force-dynamic";

function statusClass(status: string) {
  if (status === "in_range" || status === "succeeded" || status === "classified") return "good";
  if (status === "below_range" || status === "above_range" || status === "partial") return "warn";
  if (status === "failed") return "bad";
  return "";
}

function statusLabel(status: string) {
  if (status === "closed_or_zero_liquidity") return "closed";
  return status;
}

function formatFee(fee: number) {
  return `${fee / 10000}%`;
}

function numberValue(value?: number | string | null) {
  if (value === undefined || value === null || value === "") return 0;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `$${formatNumber(value, 2)}`;
}

function formatSignedUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${formatNumber(Math.abs(value), 2)}`;
}

function formatCount(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function pnlClass(value: number | null) {
  if (value === null || !Number.isFinite(value) || value === 0) return "neutral";
  return value > 0 ? "positive" : "negative";
}

function tickSpacingForFee(fee: number) {
  if (fee === 500) return 10;
  if (fee === 3000) return 60;
  if (fee === 10000) return 200;
  return 1;
}

function dprDisplay(earnedUsd: number, depositUsd: number, openedAt: Date, closedAt?: Date) {
  const elapsedDays = Math.max(((closedAt?.getTime() ?? Date.now()) - openedAt.getTime()) / 86_400_000, 1 / 24);
  if (depositUsd <= 0 || earnedUsd <= 0) return { dpr: "0%", apr: "APR 0%" };
  const dpr = (earnedUsd / depositUsd / elapsedDays) * 100;
  const apr = dpr * 365;
  return { dpr: `${formatNumber(dpr, 3)}%`, apr: `APR ${formatNumber(apr, 2)}%` };
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function shortDate(date: Date, includeYear: boolean) {
  const month = date.toLocaleString("en-US", { month: "short" }).toLowerCase();
  return `${date.getDate()} ${month}${includeYear ? ` ${date.getFullYear()}` : ""}`;
}

function positionDateRange(openedAt: Date, closedAt?: Date) {
  const endAt = closedAt ?? new Date();
  if (dateKey(openedAt) === dateKey(endAt)) return shortDate(openedAt, true);

  const sameMonth = openedAt.getFullYear() === endAt.getFullYear() && openedAt.getMonth() === endAt.getMonth();
  if (sameMonth) return `${openedAt.getDate()}–${shortDate(endAt, true)}`;

  return `${shortDate(openedAt, openedAt.getFullYear() !== endAt.getFullYear())}–${shortDate(endAt, true)}`;
}

function timeInRange(openedAt: Date, closedAt?: Date) {
  const endAt = closedAt ?? new Date();
  const totalMinutes = Math.max(0, Math.floor((endAt.getTime() - openedAt.getTime()) / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes}m`;
}

function uniswapPoolUrl(poolAddress?: string | null) {
  return poolAddress ? `https://app.uniswap.org/explore/pools/base/${poolAddress}` : undefined;
}

function aggregateLpAssetAmounts(positionLpStates: Map<string, LpAssetAmounts>) {
  const total: LpAssetAmounts = { weth: 0, usdc: 0 };

  for (const amounts of positionLpStates.values()) {
    total.weth = (total.weth ?? 0) + (amounts.weth ?? 0);
    total.usdc = (total.usdc ?? 0) + (amounts.usdc ?? 0);
  }

  return total;
}

function tokenAmountsToLpAmounts(value: unknown) {
  const amounts: LpAssetAmounts = { weth: 0, usdc: 0 };
  if (!Array.isArray(value)) return amounts;

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const amount = item as { symbol?: string; amount?: string; direction?: string };
    const parsed = Number(amount.amount);
    if (!Number.isFinite(parsed)) continue;
    const signed = amount.direction === "out" ? -parsed : parsed;
    if (amount.symbol === "WETH") amounts.weth = (amounts.weth ?? 0) + signed;
    if (amount.symbol === "USDC") amounts.usdc = (amounts.usdc ?? 0) + signed;
  }

  return amounts;
}

function isAtomicRebalanceTransaction(transaction: { raw: unknown }) {
  const liquidityDeltas = getTransactionPositionLiquidityDeltas({
    fromAddress: "",
    tokenAmounts: [],
    raw: transaction.raw
  });

  return liquidityDeltas.some((delta) => delta.delta < 0n) && liquidityDeltas.some((delta) => delta.delta > 0n);
}

function buildRebalanceDetails(
  transaction: { fromAddress: string; tokenAmounts: unknown; raw: unknown },
  positionsByTokenId: Map<string, { token0: string; token1: string }>
): TransactionTableRow["rebalanceDetails"] {
  const principalDeltas = getTransactionPositionPrincipalDeltas(transaction, positionsByTokenId);
  const closed = principalDeltas
    .filter((delta) => (delta.delta.weth ?? 0) < 0 || (delta.delta.usdc ?? 0) < 0)
    .map((delta) => ({
      tokenId: delta.tokenId,
      weth: Math.abs(delta.delta.weth ?? 0),
      usdc: Math.abs(delta.delta.usdc ?? 0)
    }));
  const minted = principalDeltas
    .filter((delta) => (delta.delta.weth ?? 0) > 0 || (delta.delta.usdc ?? 0) > 0)
    .map((delta) => ({
      tokenId: delta.tokenId,
      weth: Math.max(delta.delta.weth ?? 0, 0),
      usdc: Math.max(delta.delta.usdc ?? 0, 0)
    }));
  const earned = closed
    .map((closedPosition) => {
      const position = positionsByTokenId.get(closedPosition.tokenId);
      const exitAmounts = position
        ? getTransactionPositionExitAmounts(transaction, closedPosition.tokenId, position.token0, position.token1)
        : null;
      return exitAmounts
        ? {
            tokenId: closedPosition.tokenId,
            weth: exitAmounts.earned.weth,
            usdc: exitAmounts.earned.usdc
          }
        : null;
    })
    .filter((item): item is { tokenId: string; weth: number | null; usdc: number | null } => item !== null);

  return closed.length > 0 && minted.length > 0 ? { closed, minted, earned } : null;
}

function lpAmountValueUsd(amounts: LpAssetAmounts, wethPriceUsd: number | null) {
  if (wethPriceUsd === null) return null;
  return (amounts.weth ?? 0) * wethPriceUsd + (amounts.usdc ?? 0);
}

function tokenAmountsValueUsd(value: unknown, wethPriceUsd: number | null) {
  if (wethPriceUsd === null) return null;
  if (!Array.isArray(value)) return 0;

  return value.reduce((total, item) => {
    if (!item || typeof item !== "object") return total;
    const amount = item as { amount?: string; symbol?: string };
    const numericAmount = Number(amount.amount);
    if (!Number.isFinite(numericAmount)) return total;
    if (amount.symbol === "USDC") return total + numericAmount;
    if (amount.symbol === "WETH" || amount.symbol === "ETH") return total + numericAmount * wethPriceUsd;
    return total;
  }, 0);
}

function rebalanceCostValueUsd(
  rebalanceDetails: NonNullable<TransactionTableRow["rebalanceDetails"]>,
  leftovers: unknown,
  wethPriceUsd: number | null
) {
  const closedValue = rebalanceDetails.closed.reduce((sum, item) => sum + (lpAmountValueUsd(item, wethPriceUsd) ?? 0), 0);
  const mintedValue = rebalanceDetails.minted.reduce((sum, item) => sum + (lpAmountValueUsd(item, wethPriceUsd) ?? 0), 0);
  const earnedValue = rebalanceDetails.earned.reduce((sum, item) => sum + (lpAmountValueUsd(item, wethPriceUsd) ?? 0), 0);
  const leftoverValue = tokenAmountsValueUsd(leftovers, wethPriceUsd);

  if (leftoverValue === null) return null;
  return closedValue + earnedValue - mintedValue - leftoverValue;
}

type DailySummary = {
  portfolioUsd: number | null;
  activeFeesUsd: number | null;
  activeFeesDetail: string;
  rebalanceCount24h: number;
  rebalanceCost24hUsd: number | null;
  activeRangeLabel: string;
  activeRangeDetail: string;
  syncLabel: string;
};

function AutopilotDailySummary({ summary }: { summary: DailySummary }) {
  return (
    <div className="daily-summary" aria-label="24 hour strategy summary">
      <div className="daily-summary-head">
        <div>
          <p className="metric-label">Last 24 hours</p>
          <strong>Strategy health</strong>
        </div>
        <span className="status good">monitoring</span>
      </div>
      <div className="daily-summary-grid">
        <div>
          <span>Portfolio now</span>
          <strong>{formatUsd(summary.portfolioUsd)}</strong>
          <small>Wallet plus active LP</small>
        </div>
        <div>
          <span>Active fees</span>
          <strong>{formatUsd(summary.activeFeesUsd)}</strong>
          <small>{summary.activeFeesDetail}</small>
        </div>
        <div>
          <span>Rebalances</span>
          <strong>{formatCount(summary.rebalanceCount24h, "tx")}</strong>
          <small>Cost {formatUsd(summary.rebalanceCost24hUsd)}</small>
        </div>
        <div>
          <span>Current range</span>
          <strong>{summary.activeRangeLabel}</strong>
          <small>{summary.activeRangeDetail}</small>
        </div>
      </div>
      <p className="daily-summary-note">{summary.syncLabel}</p>
    </div>
  );
}

type ClosedPositionSnapshot = {
  closedAt: Date;
  blockNumber: string;
  depositAmounts: LpAssetAmounts;
  exitAmounts: LpAssetAmounts;
  earnedAmounts?: LpAssetAmounts;
  hodlAmounts: LpAssetAmounts;
};

function DashboardPanelLoading({ title, detail }: { title: string; detail: string }) {
  return (
    <section className="panel section dashboard-loading-panel" aria-busy="true">
      <div className="section-head">
        <div>
          <div className="loading-title-row">
            <h2>{title}</h2>
            <span className="status">loading</span>
          </div>
          <p className="muted">{detail}</p>
        </div>
      </div>
      <div className="loading-grid" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
      </div>
    </section>
  );
}

function DashboardLoadingTabs() {
  return (
    <DashboardTabs
      overview={<DashboardPanelLoading title="Narrow range swap guard" detail="Loading live wallet balances and pool range." />}
      autopilot={<DashboardPanelLoading title="Autopilot plan" detail="Loading current strategy state, risk gates, and rebalance economics." />}
      tripleGuide={<DashboardPanelLoading title="Triple range guide" detail="Loading adjacent range positions and capital split." />}
      performance={<DashboardPanelLoading title="Growth comparison" detail="Loading cached historical prices and transaction states." />}
      positions={<DashboardPanelLoading title="CL positions" detail="Loading positions, fees, and valuation snapshots." />}
      transactions={<DashboardPanelLoading title="Transactions" detail="Loading normalized transaction rows." />}
    />
  );
}

function DashboardPageLoading({ config }: { config: ReturnType<typeof getConfig> }) {
  return (
    <main className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <BrandLogo />
            <div>
              <h1>WalletBot</h1>
              <p>
                Base wallet {shortAddress(config.BASE_WALLET_ADDRESS)} · WETH/USDC Uniswap v3
              </p>
            </div>
          </div>
          <div className="actions">
            <div className="sync-cluster">
              <div className="header-sync-status">
                <div className="section-title-row">
                  <h2>Sync status</h2>
                  <span className="status">loading</span>
                </div>
                <SyncStatusLive initialRun={null} />
              </div>
              <SyncNowButton />
            </div>
            <form action={logoutAction}>
              <button className="button" type="submit">
                Log out
              </button>
            </form>
          </div>
        </header>

        <DashboardLoadingTabs />
      </div>
    </main>
  );
}

function DashboardLoadError({ message }: { message: string }) {
  return (
    <section className="panel section dashboard-loading-panel" role="status">
      <div className="section-head">
        <div>
          <div className="loading-title-row">
            <h2>Dashboard data unavailable</h2>
            <span className="status bad">error</span>
          </div>
          <p className="muted">{message}</p>
        </div>
      </div>
      <Link className="button primary" href="/">
        Retry
      </Link>
    </section>
  );
}

export default async function DashboardPage() {
  if (!(await isAuthenticated())) redirect("/login");

  const config = getConfig();
  return (
    <Suspense fallback={<DashboardPageLoading config={config} />}>
      <DashboardContent config={config} />
    </Suspense>
  );
}

async function DashboardContent({ config }: { config: ReturnType<typeof getConfig> }) {
  try {
    return await DashboardContentInner({ config });
  } catch (error) {
    return <DashboardLoadError message={error instanceof Error ? error.message : "Unable to load dashboard data."} />;
  }
}

async function DashboardContentInner({ config }: { config: ReturnType<typeof getConfig> }) {
  const walletAddress = getAddress(config.BASE_WALLET_ADDRESS);
  const walletRecord = await prisma.wallet.findUnique({ where: { address: walletAddress } });
  const transactions = await prisma.transaction.findMany({
    where: walletRecord ? { walletId: walletRecord.id } : { walletId: "__missing_wallet__" },
    orderBy: [{ blockNumber: "desc" }, { timestamp: "desc" }],
    take: 80
  });
  const latestKnownBlock = transactions[0]?.blockNumber;
  const [positions, latestRun, walletAmounts] = await Promise.all([
    walletRecord
      ? prisma.position.findMany({ where: { walletId: walletRecord.id }, orderBy: [{ tokenId: "desc" }, { createdAt: "desc" }] }).then(sortPositionsForDisplay)
      : Promise.resolve([]),
    walletRecord ? prisma.syncRun.findFirst({ where: { walletId: walletRecord.id }, orderBy: { startedAt: "desc" } }) : Promise.resolve(null),
    getWalletAssetAmountsSnapshotAtBlock(walletAddress, latestKnownBlock).catch(() => null)
  ]);
  const initialSyncRun = latestRun
    ? {
        id: latestRun.id,
        status: latestRun.status,
        startedAt: latestRun.startedAt.toISOString(),
        finishedAt: latestRun.finishedAt?.toISOString() ?? null,
        transactionsSeen: latestRun.transactionsSeen,
        error: latestRun.error
      }
    : null;

  const approvalsByTransactionId = mapApprovalsToTransactions(transactions);
  const visibleTransactions = transactions.filter((transaction) => !isApprovalTransaction(transaction));
  const transactionLpStates = new Map<string, { weth: number | null; usdc: number | null }>();
  const transactionAssetStates = new Map<string, TransactionTableRow["assets"]>();
  const chronologicalLpAssetsByPosition = new Map<string, LpAssetAmounts>();
  const chronologicalLiquidityByPosition = new Map<string, bigint>();
  const closedSnapshotsByTokenId = new Map<string, ClosedPositionSnapshot>();
  const trackedLpTokenIds = new Set(positions.map((position) => position.tokenId));
  const positionsByTokenId = new Map(positions.map((position) => [position.tokenId, position]));
  const positionTokensByTokenId = new Map(positions.map((position) => [position.tokenId, { token0: position.token0, token1: position.token1 }]));
  let runningAssets: WalletAssetAmounts = walletAmounts ?? { weth: null, usdc: null, aero: null, eth: null };
  const historicalPriceBlockNumbers = [...new Set(visibleTransactions.map((transaction) => transaction.blockNumber.toString()))];
  const exitBlockNumbers = transactions
    .filter((transaction) => transaction.type === "lp_exit" && transaction.relatedPositionTokenId)
    .map((transaction) => transaction.blockNumber.toString());
  const historicalPrices = await readHistoricalPrices([...historicalPriceBlockNumbers, ...exitBlockNumbers]);
  const initialHistoricalPrices = historicalPrices;
  const exitHistoricalPrices = historicalPrices;

  for (const transaction of transactions) {
    if (transaction.type === "lp_exit" && transaction.relatedPositionTokenId) trackedLpTokenIds.add(transaction.relatedPositionTokenId);
  }

  for (const transaction of [...transactions].reverse()) {
    const liquidityDeltas = getTransactionPositionLiquidityDeltas(transaction).filter((liquidityDelta) =>
      trackedLpTokenIds.has(liquidityDelta.tokenId)
    );
    const principalDeltas = getTransactionPositionPrincipalDeltas(transaction, positionTokensByTokenId);
    const closedTokenIds = new Set<string>();

    for (const liquidityDelta of liquidityDeltas) {
      if (!trackedLpTokenIds.has(liquidityDelta.tokenId)) continue;
      chronologicalLiquidityByPosition.set(
        liquidityDelta.tokenId,
        (chronologicalLiquidityByPosition.get(liquidityDelta.tokenId) ?? 0n) + liquidityDelta.delta
      );
    }

    for (const liquidityDelta of liquidityDeltas) {
      const remainingLiquidity = chronologicalLiquidityByPosition.get(liquidityDelta.tokenId);
      if (remainingLiquidity === undefined || remainingLiquidity > 0n) continue;

      const position = positionsByTokenId.get(liquidityDelta.tokenId);
      const exitAmounts = position
        ? getTransactionPositionExitAmounts(transaction, liquidityDelta.tokenId, position.token0, position.token1)
        : null;
      if (!exitAmounts) continue;

      closedSnapshotsByTokenId.set(liquidityDelta.tokenId, {
        closedAt: transaction.timestamp,
        blockNumber: transaction.blockNumber.toString(),
        depositAmounts: exitAmounts.principal,
        exitAmounts: exitAmounts.collected,
        earnedAmounts: exitAmounts.earned,
        hodlAmounts: chronologicalLpAssetsByPosition.get(liquidityDelta.tokenId) ?? exitAmounts.principal
      });
      chronologicalLpAssetsByPosition.delete(liquidityDelta.tokenId);
      chronologicalLiquidityByPosition.delete(liquidityDelta.tokenId);
      closedTokenIds.add(liquidityDelta.tokenId);
    }

    if (transaction.type === "lp_exit") {
      if (transaction.relatedPositionTokenId) {
        const position = positionsByTokenId.get(transaction.relatedPositionTokenId);
        const exitAmounts = position
          ? getTransactionPositionExitAmounts(transaction, transaction.relatedPositionTokenId, position.token0, position.token1)
          : null;
        if (!closedSnapshotsByTokenId.has(transaction.relatedPositionTokenId)) {
          closedSnapshotsByTokenId.set(transaction.relatedPositionTokenId, {
            closedAt: transaction.timestamp,
            blockNumber: transaction.blockNumber.toString(),
            depositAmounts:
              exitAmounts?.principal ?? chronologicalLpAssetsByPosition.get(transaction.relatedPositionTokenId) ?? { weth: 0, usdc: 0 },
            exitAmounts: exitAmounts?.collected ?? tokenAmountsToLpAmounts(transaction.tokenAmounts),
            earnedAmounts: exitAmounts?.earned,
            hodlAmounts: chronologicalLpAssetsByPosition.get(transaction.relatedPositionTokenId) ?? { weth: 0, usdc: 0 }
          });
          chronologicalLpAssetsByPosition.delete(transaction.relatedPositionTokenId);
          chronologicalLiquidityByPosition.delete(transaction.relatedPositionTokenId);
          closedTokenIds.add(transaction.relatedPositionTokenId);
        }
      } else {
        chronologicalLpAssetsByPosition.clear();
        chronologicalLiquidityByPosition.clear();
      }
    } else if (
      transaction.relatedPositionTokenId &&
      trackedLpTokenIds.has(transaction.relatedPositionTokenId) &&
      transaction.type.startsWith("lp_") &&
      transaction.type !== "lp_collect" &&
      !closedTokenIds.has(transaction.relatedPositionTokenId)
    ) {
      const current = chronologicalLpAssetsByPosition.get(transaction.relatedPositionTokenId) ?? { weth: 0, usdc: 0 };
      const eventDelta = principalDeltas.find((delta) => delta.tokenId === transaction.relatedPositionTokenId)?.delta;
      const next = addLpDelta(current, eventDelta ?? getTransactionLpDelta(transaction));
      const remainingLiquidity = chronologicalLiquidityByPosition.get(transaction.relatedPositionTokenId);
      chronologicalLpAssetsByPosition.set(
        transaction.relatedPositionTokenId,
        remainingLiquidity !== undefined && remainingLiquidity <= 0n ? { weth: 0, usdc: 0 } : next
      );
    }

    transactionLpStates.set(transaction.id, aggregateLpAssetAmounts(chronologicalLpAssetsByPosition));
  }

  for (const transaction of transactions) {
    const lpAssets = transactionLpStates.get(transaction.id) ?? { weth: 0, usdc: 0 };
    transactionAssetStates.set(transaction.id, {
      weth: runningAssets.weth,
      usdc: runningAssets.usdc,
      aero: runningAssets.aero,
      eth: runningAssets.eth,
      lpWeth: lpAssets.weth,
      lpUsdc: lpAssets.usdc
    });
    runningAssets = subtractDelta(runningAssets, getTransactionAssetDelta(transaction, walletAddress));
  }

  const transactionRows: TransactionTableRow[] = visibleTransactions.map((transaction) => ({
    id: transaction.id,
    hash: transaction.hash,
    blockNumber: transaction.blockNumber.toString(),
    timestamp: transaction.timestamp.toISOString(),
    type: transaction.type,
    displayType: isAtomicRebalanceTransaction(transaction) ? "rebalance" : transaction.type,
    tokenAmounts: transaction.tokenAmounts,
    protocol: transaction.protocol,
    relatedPositionTokenId: transaction.relatedPositionTokenId,
    classificationStatus: transaction.classificationStatus,
    approvals: (approvalsByTransactionId.get(transaction.id) ?? []).map((approval) => ({ hash: approval.hash })),
    rebalanceDetails: isAtomicRebalanceTransaction(transaction) ? buildRebalanceDetails(transaction, positionsByTokenId) : null,
    assets: transactionAssetStates.get(transaction.id) ?? { weth: null, usdc: null, aero: null, eth: null, lpWeth: null, lpUsdc: null }
  }));

  const firstPositionActivityByTokenId = new Map<string, Date>();

  for (const transaction of transactions) {
    if (!transaction.relatedPositionTokenId) continue;

    const firstActivity = firstPositionActivityByTokenId.get(transaction.relatedPositionTokenId);
    if (!firstActivity || transaction.timestamp < firstActivity) {
      firstPositionActivityByTokenId.set(transaction.relatedPositionTokenId, transaction.timestamp);
    }
  }

  const feesByTokenId = new Map(
    await Promise.all(
      positions.map(async (position) => [
        position.tokenId,
        await getUncollectedPositionFees({
          tokenId: position.tokenId,
          token0: position.token0,
          token1: position.token1,
          walletAddress
        }).catch(() => ({ weth: 0, usdc: 0 }))
      ] as const)
    )
  );

  const positionRows: PositionTableRow[] = positions.map((position) => {
    const closedSnapshot = closedSnapshotsByTokenId.get(position.tokenId);
    const isClosed = position.status === "closed_or_zero_liquidity";
    const currentPrice =
      position.currentTick === null ? null : tickToWethUsdcPrice(position.currentTick, position.token0, position.token1);
    const tickSpacing = tickSpacingForFee(position.fee);
    const rangeCount = Math.max(1, Math.round((position.tickUpper - position.tickLower) / tickSpacing));
    const tickLowerExtendedPrice = tickToWethUsdcPrice(position.tickLower - tickSpacing / 2, position.token0, position.token1);
    const tickLowerPrice = tickToWethUsdcPrice(position.tickLower, position.token0, position.token1);
    const tickUpperPrice = tickToWethUsdcPrice(position.tickUpper, position.token0, position.token1);
    const tickUpperExtendedPrice = tickToWethUsdcPrice(position.tickUpper + tickSpacing / 2, position.token0, position.token1);
    const lowerExtendedPrice =
      tickLowerExtendedPrice === null || tickUpperExtendedPrice === null ? null : Math.min(tickLowerExtendedPrice, tickUpperExtendedPrice);
    const upperExtendedPrice =
      tickLowerExtendedPrice === null || tickUpperExtendedPrice === null ? null : Math.max(tickLowerExtendedPrice, tickUpperExtendedPrice);
    const lowerPrice = tickLowerPrice === null || tickUpperPrice === null ? null : Math.min(tickLowerPrice, tickUpperPrice);
    const upperPrice = tickLowerPrice === null || tickUpperPrice === null ? null : Math.max(tickLowerPrice, tickUpperPrice);
    const historicalPrice = closedSnapshot ? (exitHistoricalPrices[closedSnapshot.blockNumber]?.ethPriceUsd ?? currentPrice) : null;
    const currentPositionAmounts = {
      weth: numberValue(position.wethAmount),
      usdc: numberValue(position.usdcAmount)
    };
    const missingClosedSnapshot = isClosed && !closedSnapshot;
    const fallbackClosedDepositAmounts = isClosed ? chronologicalLpAssetsByPosition.get(position.tokenId) : undefined;
    const unknownClosedAmounts = { weth: null, usdc: null };
    const displayAmounts = closedSnapshot?.depositAmounts ?? (missingClosedSnapshot ? unknownClosedAmounts : currentPositionAmounts);
    const totalAmounts = closedSnapshot?.exitAmounts ?? (missingClosedSnapshot ? unknownClosedAmounts : currentPositionAmounts);
    const depositAmounts = closedSnapshot?.depositAmounts ?? fallbackClosedDepositAmounts ?? currentPositionAmounts;
    const earned = closedSnapshot?.earnedAmounts ?? (missingClosedSnapshot ? unknownClosedAmounts : (feesByTokenId.get(position.tokenId) ?? { weth: 0, usdc: 0 }));
    const valuationPrice = closedSnapshot
      ? historicalPrice
      : latestKnownBlock
        ? (historicalPrices[latestKnownBlock.toString()]?.ethPriceUsd ?? currentPrice)
        : currentPrice;
    const depositUsd = lpAmountValueUsd(depositAmounts, valuationPrice);
    const totalUsd = lpAmountValueUsd(totalAmounts, valuationPrice);
    const earnedUsd = valuationPrice === null ? null : (earned.weth ?? 0) * valuationPrice + (earned.usdc ?? 0);
    const displayedTotalUsd = missingClosedSnapshot
      ? null
      : closedSnapshot
        ? totalUsd
        : depositUsd === null || earnedUsd === null
          ? null
          : depositUsd + earnedUsd;
    const hodlAmounts = closedSnapshot?.hodlAmounts ?? chronologicalLpAssetsByPosition.get(position.tokenId) ?? depositAmounts;
    const hodlUsd = lpAmountValueUsd(hodlAmounts, valuationPrice);
    const pnlUsd = missingClosedSnapshot || displayedTotalUsd === null || hodlUsd === null ? null : displayedTotalUsd - hodlUsd;
    const openedAt = firstPositionActivityByTokenId.get(position.tokenId) ?? position.createdAt;
    const poolUrl = uniswapPoolUrl(position.poolAddress);
    const rate = depositUsd === null || earnedUsd === null ? null : dprDisplay(earnedUsd, depositUsd, openedAt, closedSnapshot?.closedAt);

    return {
      id: position.id,
      tokenId: position.tokenId,
      status: position.status,
      statusClassName: statusClass(position.status),
      statusLabel: statusLabel(position.status),
      isClosed,
      date: positionDateRange(openedAt, closedSnapshot?.closedAt),
      timeInRange: timeInRange(openedAt, closedSnapshot?.closedAt),
      priceRange: {
        lowerExtendedPrice,
        lowerPrice,
        upperPrice,
        upperExtendedPrice,
        currentPrice,
        lowerLabel: `Min ${formatUsd(lowerPrice)}`,
        upperLabel: `Max ${formatUsd(upperPrice)}`,
        rangeCount,
        livePriceEndpoint: position.fee === 3000 ? "/api/rebalance?widthMultiplier=1" : undefined
      },
      positionAmounts: {
        weth: formatNumber(displayAmounts.weth, 6),
        usdc: formatNumber(displayAmounts.usdc, 2),
        note: missingClosedSnapshot ? "close snapshot unavailable" : isClosed ? "at close" : null
      },
      deposit: {
        total: formatUsd(depositUsd),
        wethUsd: formatUsd(valuationPrice === null ? null : (depositAmounts.weth ?? 0) * valuationPrice),
        usdcUsd: formatUsd(depositAmounts.usdc ?? 0),
        note: missingClosedSnapshot ? "opened" : isClosed ? "at close" : null
      },
      earned: {
        total: formatUsd(earnedUsd),
        weth: formatNumber(earned.weth, 6),
        usdc: formatNumber(earned.usdc, 2),
        note: missingClosedSnapshot ? "close snapshot unavailable" : isClosed ? "realized" : null
      },
      total: formatUsd(displayedTotalUsd),
      totalNote: missingClosedSnapshot ? "close snapshot unavailable" : isClosed ? "at close" : null,
      dpr: rate,
      pnl: {
        value: formatSignedUsd(pnlUsd),
        className: pnlClass(pnlUsd),
        note: "vs hold"
      },
      pool: {
        fee: formatFee(position.fee),
        address: shortAddress(position.poolAddress),
        url: poolUrl ?? null
      }
    };
  });

  const activePositions = positions.filter((position) => position.status !== "closed_or_zero_liquidity" && position.liquidity !== "0");
  const currentWethPrice =
    activePositions
      .map((position) => (position.currentTick === null ? null : tickToWethUsdcPrice(position.currentTick, position.token0, position.token1)))
      .find((price): price is number => price !== null) ??
    (latestKnownBlock ? (historicalPrices[latestKnownBlock.toString()]?.ethPriceUsd ?? null) : null);
  const activeLpAmounts = activePositions.reduce<LpAssetAmounts>(
    (total, position) => ({
      weth: (total.weth ?? 0) + numberValue(position.wethAmount),
      usdc: (total.usdc ?? 0) + numberValue(position.usdcAmount)
    }),
    { weth: 0, usdc: 0 }
  );
  const activeFeeAmounts = activePositions.reduce<LpAssetAmounts>(
    (total, position) => {
      const fees = feesByTokenId.get(position.tokenId) ?? { weth: 0, usdc: 0 };
      return {
        weth: (total.weth ?? 0) + (fees.weth ?? 0),
        usdc: (total.usdc ?? 0) + (fees.usdc ?? 0)
      };
    },
    { weth: 0, usdc: 0 }
  );
  const activeLpUsd = lpAmountValueUsd(activeLpAmounts, currentWethPrice);
  const activeFeesUsd = lpAmountValueUsd(activeFeeAmounts, currentWethPrice);
  const walletWethUsd = currentWethPrice === null || walletAmounts?.weth === null || walletAmounts?.weth === undefined ? null : walletAmounts.weth * currentWethPrice;
  const walletEthUsd = currentWethPrice === null || walletAmounts?.eth === null || walletAmounts?.eth === undefined ? null : walletAmounts.eth * currentWethPrice;
  const walletUsdcUsd = walletAmounts?.usdc ?? null;
  const currentPortfolioUsd =
    currentWethPrice === null
      ? null
      : (walletWethUsd ?? 0) + (walletEthUsd ?? 0) + (walletUsdcUsd ?? 0) + (activeLpUsd ?? 0);
  const dayAgo = new Date(Date.now() - 86_400_000);
  const recentRebalanceCosts = visibleTransactions
    .filter((transaction) => transaction.timestamp >= dayAgo && isAtomicRebalanceTransaction(transaction))
    .map((transaction) => {
      const details = buildRebalanceDetails(transaction, positionsByTokenId);
      if (!details) return null;
      const price = historicalPrices[transaction.blockNumber.toString()]?.ethPriceUsd ?? currentWethPrice;
      return rebalanceCostValueUsd(details, transaction.tokenAmounts, price);
    })
    .filter((value): value is number => value !== null && Number.isFinite(value));
  const currentActivePosition = activePositions[0] ?? null;
  const activeRangeLower = currentActivePosition ? tickToWethUsdcPrice(currentActivePosition.tickLower, currentActivePosition.token0, currentActivePosition.token1) : null;
  const activeRangeUpper = currentActivePosition ? tickToWethUsdcPrice(currentActivePosition.tickUpper, currentActivePosition.token0, currentActivePosition.token1) : null;
  const activeRangeLabel =
    currentActivePosition && activeRangeLower !== null && activeRangeUpper !== null
      ? `#${currentActivePosition.tokenId}`
      : activePositions.length === 0
        ? "No active range"
        : "Active range";
  const activeRangeDetail =
    currentActivePosition && activeRangeLower !== null && activeRangeUpper !== null
      ? `${formatUsd(Math.min(activeRangeLower, activeRangeUpper))} - ${formatUsd(Math.max(activeRangeLower, activeRangeUpper))}`
      : activePositions.length === 0
        ? "Waiting for a new position"
        : "Range price unavailable";
  const dailySummary: DailySummary = {
    portfolioUsd: currentPortfolioUsd,
    activeFeesUsd,
    activeFeesDetail: `${formatNumber(activeFeeAmounts.weth, 6)} WETH / ${formatNumber(activeFeeAmounts.usdc, 2)} USDC uncollected`,
    rebalanceCount24h: recentRebalanceCosts.length,
    rebalanceCost24hUsd: recentRebalanceCosts.reduce((sum, value) => sum + value, 0),
    activeRangeLabel,
    activeRangeDetail,
    syncLabel: latestRun
      ? `Last sync ${latestRun.status} at ${latestRun.finishedAt?.toLocaleString() ?? latestRun.startedAt.toLocaleString()}`
      : "Sync has not run yet."
  };

  return (
    <main className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <BrandLogo />
            <div>
              <h1>WalletBot</h1>
              <p>
                Base wallet {shortAddress(config.BASE_WALLET_ADDRESS)} · WETH/USDC Uniswap v3
              </p>
            </div>
          </div>
          <div className="actions">
            <div className="sync-cluster">
              <div className="header-sync-status">
                <div className="section-title-row">
                  <h2>Sync status</h2>
                  {latestRun ? (
                    <span className={`status ${statusClass(latestRun.status)}`}>{statusLabel(latestRun.status)}</span>
                  ) : (
                    <span className="status">not started</span>
                  )}
                </div>
                <SyncStatusLive initialRun={initialSyncRun} />
              </div>
              <SyncNowButton />
            </div>
            <form action={logoutAction}>
              <button className="button" type="submit">
                Log out
              </button>
            </form>
          </div>
        </header>

        <DashboardTabs
          overview={
            <section className="panel section overview-panel">
              <div className="section-head">
                <div>
                  <h2>Narrow range swap guard</h2>
                  <p className="muted">Live WETH/USDC balance target for the tight 0.3% Uniswap v3 range.</p>
                </div>
              </div>
              <NarrowRangeRebalanceLive />
            </section>
          }
          autopilot={
            <section className="panel section">
              <div className="section-head">
                <div>
                  <h2>Autopilot plan</h2>
                  <p className="muted">Decision state, planned range actions, immediate rebalance cost, and reversal-debt guardrails.</p>
                </div>
              </div>
              <AutopilotDailySummary summary={dailySummary} />
              <AutopilotPlanLive />
            </section>
          }
          tripleGuide={
            <section className="panel section">
              <div className="section-head">
                <div>
                  <h2>Triple range guide</h2>
                  <p className="muted">Three adjacent narrow WETH/USDC ranges with one working interval and two token-only guards.</p>
                </div>
              </div>
              <TripleRangeGuideLive />
            </section>
          }
          performance={
            <section className="panel section">
              <div className="section-head">
                <div>
                  <h2>Growth comparison</h2>
                  <p className="muted">Portfolio growth is neutralized for deposits and withdrawals, then compared with WETH.</p>
                </div>
              </div>
              <GrowthChart rows={transactionRows} initialPrices={initialHistoricalPrices} />
            </section>
          }
          positions={
            <section className="panel section">
              <div className="section-head">
                <div>
                  <h2>CL positions</h2>
                  <p className="muted">Automatically discovered Uniswap v3 WETH/USDC NFT positions.</p>
                </div>
              </div>
              <PositionsTable rows={positionRows} />
            </section>
          }
          transactions={
            <section className="panel section">
              <div className="section-head">
                <div>
                  <h2>Transactions</h2>
                  <p className="muted">Normalized investor view backed by stored raw Blockscout/RPC payloads.</p>
                </div>
              </div>
              <TransactionsTable rows={transactionRows} initialPrices={initialHistoricalPrices} />
            </section>
          }
        />
      </div>
    </main>
  );
}
