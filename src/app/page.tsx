import { redirect } from "next/navigation";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { formatNumber, shortAddress } from "@/lib/format";
import { readHistoricalPrices } from "@/lib/historical-prices";
import { getUncollectedPositionFees } from "@/lib/uniswap-v3-fees";
import { tickToWethUsdcPrice } from "@/lib/uniswap-v3-position";
import {
  getNextLpAssetAmounts,
  getTransactionAssetDelta,
  getWalletAssetAmountsSnapshot,
  subtractDelta,
  type LpAssetAmounts,
  type WalletAssetAmounts
} from "@/lib/wallet-assets";
import { logoutAction } from "./actions";
import { SyncNowButton } from "./sync-now-button";
import { SyncStatusLive } from "./sync-status-live";
import { NarrowRangeRebalanceLive } from "./narrow-range-rebalance-live";
import { PriceRangeVisual } from "./price-range-visual";
import { TransactionsTable, type TransactionTableRow } from "./transactions-table";

export const dynamic = "force-dynamic";

function statusClass(status: string) {
  if (status === "in_range" || status === "succeeded" || status === "classified") return "good";
  if (status === "below_range" || status === "above_range" || status === "partial") return "warn";
  if (status === "failed") return "bad";
  return "";
}

function formatFee(fee: number) {
  return `${fee / 10000}%`;
}

function formatPrice(tick: number | null | undefined, token0: string, token1: string) {
  if (tick === null || tick === undefined) return "-";
  return `$${formatNumber(tickToWethUsdcPrice(tick, token0, token1), 2)}`;
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

function rangeMarkerPosition(tickLower: number, tickUpper: number, currentTick: number | null) {
  if (currentTick === null) return 50;
  const range = tickUpper - tickLower;
  if (range <= 0) return 50;
  return Math.min(100, Math.max(0, ((currentTick - tickLower) / range) * 100));
}

function dprDisplay(earnedUsd: number, depositUsd: number, openedAt: Date) {
  const elapsedDays = Math.max((Date.now() - openedAt.getTime()) / 86_400_000, 1 / 24);
  if (depositUsd <= 0 || earnedUsd <= 0) return { dpr: "0%", apr: "APR 0%" };
  const dpr = (earnedUsd / depositUsd / elapsedDays) * 100;
  const apr = dpr * 365;
  return { dpr: `${formatNumber(dpr, 3)}%`, apr: `APR ${formatNumber(apr, 2)}%` };
}

function uniswapPoolUrl(poolAddress?: string | null) {
  return poolAddress ? `https://app.uniswap.org/explore/pools/base/${poolAddress}` : undefined;
}

export default async function DashboardPage() {
  if (!(await isAuthenticated())) redirect("/login");

  const config = getConfig();
  const [transactions, positions, latestRun, walletAmounts] = await Promise.all([
    prisma.transaction.findMany({
      orderBy: [{ blockNumber: "desc" }, { timestamp: "desc" }],
      take: 80
    }),
    prisma.position.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    getWalletAssetAmountsSnapshot(getAddress(config.BASE_WALLET_ADDRESS)).catch(() => null)
  ]);

  const approvalsByTransactionId = mapApprovalsToTransactions(transactions);
  const visibleTransactions = transactions.filter((transaction) => !isApprovalTransaction(transaction));
  const transactionLpStates = new Map<string, { weth: number | null; usdc: number | null }>();
  const transactionAssetStates = new Map<string, TransactionTableRow["assets"]>();
  let chronologicalLpAssets: LpAssetAmounts = { weth: 0, usdc: 0 };
  let runningAssets: WalletAssetAmounts = walletAmounts ?? { weth: null, usdc: null, aero: null, eth: null };
  const historicalPriceBlockNumbers = [...new Set(visibleTransactions.map((transaction) => transaction.blockNumber.toString()))];
  const initialHistoricalPrices = await readHistoricalPrices(historicalPriceBlockNumbers);

  for (const transaction of [...transactions].reverse()) {
    chronologicalLpAssets = getNextLpAssetAmounts(chronologicalLpAssets, transaction);
    transactionLpStates.set(transaction.id, chronologicalLpAssets);
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
    runningAssets = subtractDelta(runningAssets, getTransactionAssetDelta(transaction, getAddress(config.BASE_WALLET_ADDRESS)));
  }

  const transactionRows: TransactionTableRow[] = visibleTransactions.map((transaction) => ({
    id: transaction.id,
    hash: transaction.hash,
    blockNumber: transaction.blockNumber.toString(),
    timestamp: transaction.timestamp.toISOString(),
    type: transaction.type,
    tokenAmounts: transaction.tokenAmounts,
    protocol: transaction.protocol,
    relatedPositionTokenId: transaction.relatedPositionTokenId,
    classificationStatus: transaction.classificationStatus,
    approvals: (approvalsByTransactionId.get(transaction.id) ?? []).map((approval) => ({ hash: approval.hash })),
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
          walletAddress: getAddress(config.BASE_WALLET_ADDRESS)
        }).catch(() => ({ weth: 0, usdc: 0 }))
      ] as const)
    )
  );

  return (
    <main className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <div>
              <h1>WalletBot</h1>
              <p>
                Base wallet {shortAddress(config.BASE_WALLET_ADDRESS)} · WETH/USDC Uniswap v3
              </p>
            </div>
          </div>
          <div className="actions">
            <SyncNowButton />
            <form action={logoutAction}>
              <button className="button" type="submit">
                Log out
              </button>
            </form>
          </div>
        </header>

        <section className="panel section overview-panel">
          <div className="overview-main">
            <div className="section-head">
              <div>
                <h2>Narrow range swap guard</h2>
                <p className="muted">Live WETH/USDC balance target for the tight 0.3% Uniswap v3 range.</p>
              </div>
            </div>
            <NarrowRangeRebalanceLive />
          </div>
          <aside className="overview-sync">
            <div className="section-title-row">
              <h2>Sync status</h2>
              {latestRun ? (
                <span className={`status ${statusClass(latestRun.status)}`}>{latestRun.status}</span>
              ) : (
                <span className="status">not started</span>
              )}
            </div>
            <p className="muted">Polling worker imports wallet activity and refreshes position range state.</p>
            <SyncStatusLive
              initialRun={
                latestRun
                  ? {
                      id: latestRun.id,
                      status: latestRun.status,
                      startedAt: latestRun.startedAt.toISOString(),
                      finishedAt: latestRun.finishedAt?.toISOString() ?? null,
                      transactionsSeen: latestRun.transactionsSeen,
                      error: latestRun.error
                    }
                  : null
              }
            />
          </aside>
        </section>

        <section className="panel section">
          <div className="section-head">
            <div>
              <h2>CL positions</h2>
              <p className="muted">Automatically discovered Uniswap v3 WETH/USDC NFT positions.</p>
            </div>
          </div>
          <div className="table-wrap">
            <table className="positions-table">
              <colgroup>
                <col className="position-col-token" />
                <col className="position-col-status" />
                <col className="position-col-range" />
                <col className="position-col-amounts" />
                <col className="position-col-deposit" />
                <col className="position-col-earned" />
                <col className="position-col-total" />
                <col className="position-col-dpr" />
                <col className="position-col-pool" />
              </colgroup>
              <thead>
                <tr>
                  <th>Token ID</th>
                  <th>Status</th>
                  <th>Price range</th>
                  <th>Position</th>
                  <th>Deposit</th>
                  <th>Earned</th>
                  <th>Total</th>
                  <th>DPR</th>
                  <th>Pool</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={9}>No positions found yet.</td>
                  </tr>
                ) : (
                  positions.map((position) => {
                    const currentPrice =
                      position.currentTick === null ? null : tickToWethUsdcPrice(position.currentTick, position.token0, position.token1);
                    const lowerPrice = tickToWethUsdcPrice(position.tickLower, position.token0, position.token1);
                    const upperPrice = tickToWethUsdcPrice(position.tickUpper, position.token0, position.token1);
                    const wethAmount = numberValue(position.wethAmount);
                    const usdcAmount = numberValue(position.usdcAmount);
                    const earned = feesByTokenId.get(position.tokenId) ?? { weth: 0, usdc: 0 };
                    const depositUsd = currentPrice === null ? null : wethAmount * currentPrice + usdcAmount;
                    const earnedUsd = currentPrice === null ? null : earned.weth * currentPrice + earned.usdc;
                    const totalUsd = depositUsd === null || earnedUsd === null ? null : depositUsd + earnedUsd;
                    const openedAt = firstPositionActivityByTokenId.get(position.tokenId) ?? position.createdAt;
                    const markerPosition = rangeMarkerPosition(position.tickLower, position.tickUpper, position.currentTick);
                    const poolUrl = uniswapPoolUrl(position.poolAddress);
                    const rate = depositUsd === null || earnedUsd === null ? null : dprDisplay(earnedUsd, depositUsd, openedAt);

                    return (
                      <tr key={position.id}>
                        <td>#{position.tokenId}</td>
                        <td>
                          <span className={`status ${statusClass(position.status)}`}>{position.status}</span>
                        </td>
                        <td>
                          <div className="price-range-cell">
                            <div className="price-stack">
                              <span>Max {formatPrice(position.tickUpper, position.token0, position.token1)}</span>
                              <strong>Now {formatPrice(position.currentTick, position.token0, position.token1)}</strong>
                              <span>Min {formatPrice(position.tickLower, position.token0, position.token1)}</span>
                            </div>
                            <PriceRangeVisual
                              lowerPrice={lowerPrice}
                              upperPrice={upperPrice}
                              currentPrice={currentPrice}
                              markerPosition={markerPosition}
                            />
                          </div>
                        </td>
                        <td>
                          <div className="asset-cell position-amounts">
                            <span>{formatNumber(position.wethAmount, 6)} WETH</span>
                            <span>{formatNumber(position.usdcAmount, 2)} USDC</span>
                          </div>
                        </td>
                        <td>
                          <div className="asset-cell deposit-cell">
                            <strong>{formatUsd(depositUsd)}</strong>
                            <span className="deposit-parts">
                              <span>{formatUsd(currentPrice === null ? null : wethAmount * currentPrice)}</span>
                              <span>+ {formatUsd(usdcAmount)}</span>
                            </span>
                          </div>
                        </td>
                        <td>
                          <div className="asset-cell">
                            <strong>{formatUsd(earnedUsd)}</strong>
                            <span>{formatNumber(earned.weth, 6)} WETH</span>
                            <span>{formatNumber(earned.usdc, 2)} USDC</span>
                          </div>
                        </td>
                        <td>
                          <strong className="total-cell">{formatUsd(totalUsd)}</strong>
                        </td>
                        <td>
                          {rate ? (
                            <span className="dpr-cell">
                              <span>{rate.dpr}</span>
                              <span>{rate.apr}</span>
                            </span>
                          ) : (
                            "-"
                          )}
                        </td>
                        <td>
                          <div className="pool-cell">
                            <strong>{formatFee(position.fee)}</strong>
                            {poolUrl ? (
                              <a className="pool-link" href={poolUrl} target="_blank" rel="noreferrer">
                                {shortAddress(position.poolAddress)}
                              </a>
                            ) : (
                              <span>{shortAddress(position.poolAddress)}</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>

        <section className="panel section">
          <div className="section-head">
            <div>
              <h2>Transactions</h2>
              <p className="muted">Normalized investor view backed by stored raw Blockscout/RPC payloads.</p>
            </div>
          </div>
          <TransactionsTable rows={transactionRows} initialPrices={initialHistoricalPrices} />
        </section>
      </div>
    </main>
  );
}
