import { redirect } from "next/navigation";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { formatNumber, shortAddress } from "@/lib/format";
import { readHistoricalPrices } from "@/lib/historical-prices";
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
            <table>
              <thead>
                <tr>
                  <th>Token ID</th>
                  <th>Status</th>
                  <th>Price range</th>
                  <th>Position</th>
                  <th>Pool</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No positions found yet.</td>
                  </tr>
                ) : (
                  positions.map((position) => (
                    <tr key={position.id}>
                      <td>#{position.tokenId}</td>
                      <td>
                        <span className={`status ${statusClass(position.status)}`}>{position.status}</span>
                      </td>
                      <td>
                        <div className="price-stack">
                          <span>Max {formatPrice(position.tickUpper, position.token0, position.token1)}</span>
                          <strong>Now {formatPrice(position.currentTick, position.token0, position.token1)}</strong>
                          <span>Min {formatPrice(position.tickLower, position.token0, position.token1)}</span>
                        </div>
                      </td>
                      <td>
                        <div className="asset-cell">
                          <strong>{formatNumber(position.wethAmount, 6)} WETH</strong>
                          <span>{formatNumber(position.usdcAmount, 2)} USDC</span>
                        </div>
                      </td>
                      <td>
                        <div className="pool-cell">
                          <strong>{formatFee(position.fee)}</strong>
                          <span>{shortAddress(position.poolAddress)}</span>
                        </div>
                      </td>
                    </tr>
                  ))
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
