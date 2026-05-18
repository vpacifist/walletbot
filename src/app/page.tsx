import { redirect } from "next/navigation";
import { TransactionType } from "@prisma/client";
import { getAddress } from "viem";
import { isAuthenticated } from "@/lib/auth";
import { isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";
import { EXPLORER_TX_URL } from "@/lib/constants";
import { getConfig } from "@/lib/config";
import { prisma } from "@/lib/db";
import { formatNumber, shortAddress } from "@/lib/format";
import {
  amountsToPortfolioSnapshot,
  getNextLpAssetAmounts,
  getTransactionAssetDelta,
  getWalletAssetSnapshot,
  snapshotToAmounts,
  subtractDelta,
  type LpAssetAmounts,
  type WalletAssetSnapshot
} from "@/lib/wallet-assets";
import { logoutAction, runSyncAction } from "./actions";

function statusClass(status: string) {
  if (status === "in_range" || status === "succeeded" || status === "classified") return "good";
  if (status === "below_range" || status === "above_range" || status === "partial") return "warn";
  if (status === "failed") return "bad";
  return "";
}

function tokenAmountUsd(amount: { amount?: string; symbol?: string }, prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }) {
  const numericAmount = Number(amount.amount);
  if (!Number.isFinite(numericAmount)) return null;
  if (amount.symbol === "USDC") return numericAmount;
  if ((amount.symbol === "WETH" || amount.symbol === "ETH") && prices?.ethPriceUsd !== undefined && prices.ethPriceUsd !== null) {
    return numericAmount * prices.ethPriceUsd;
  }
  if (amount.symbol === "AERO" && prices?.aeroPriceUsd !== undefined && prices.aeroPriceUsd !== null) return numericAmount * prices.aeroPriceUsd;
  return null;
}

function impliedAeroPriceUsd(value: unknown) {
  if (!Array.isArray(value)) return null;

  let aeroAmount = 0;
  let usdcAmount = 0;

  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const amount = item as { amount?: string; symbol?: string };
    const numericAmount = Number(amount.amount);
    if (!Number.isFinite(numericAmount)) continue;
    if (amount.symbol === "AERO") aeroAmount += Math.abs(numericAmount);
    if (amount.symbol === "USDC") usdcAmount += Math.abs(numericAmount);
  }

  if (aeroAmount <= 0 || usdcAmount <= 0) return null;
  return usdcAmount / aeroAmount;
}

function tokenAmountRows(value: unknown, prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }) {
  if (!Array.isArray(value) || value.length === 0) return "-";
  const rows = value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const amount = item as { direction?: string; amount?: string; symbol?: string };
      const sign = amount.direction === "out" ? "-" : "+";
      const usdValue = tokenAmountUsd(amount, prices);
      const signedUsd = usdValue === null ? "-" : `${sign}${formatUsd(usdValue)}`;

      return (
        <div className="amount-row" key={`${amount.symbol ?? "token"}-${index}`}>
          <span>
            {sign}
            {formatNumber(amount.amount, 6)} {amount.symbol ?? ""}
          </span>
          <span>{signedUsd}</span>
        </div>
      );
    })
    .filter(Boolean);

  if (rows.length === 0) return "-";
  return <div className="amounts-cell">{rows}</div>;
}

function formatUsd(value?: number | null) {
  if (value === undefined || value === null) return "-";
  return `$${formatNumber(value, 2)}`;
}

function walletAssetCell(asset?: WalletAssetSnapshot["weth" | "usdc" | "aero" | "eth"]) {
  if (!asset || asset.amount === null) return "-";
  const amountDigits = asset.symbol === "USDC" ? 2 : 6;

  return (
    <div className="asset-cell">
      <strong>{formatNumber(asset.amount, amountDigits)}</strong>
      <span>{formatUsd(asset.valueUsd)}</span>
    </div>
  );
}

export default async function DashboardPage() {
  if (!(await isAuthenticated())) redirect("/login");

  const config = getConfig();
  const [wallet, transactions, positions, latestRun, counts, walletAssets] = await Promise.all([
    prisma.wallet.findUnique({ where: { address: config.BASE_WALLET_ADDRESS } }),
    prisma.transaction.findMany({
      orderBy: [{ blockNumber: "desc" }, { timestamp: "desc" }],
      take: 80
    }),
    prisma.position.findMany({ orderBy: { updatedAt: "desc" } }),
    prisma.syncRun.findFirst({ orderBy: { startedAt: "desc" } }),
    prisma.transaction.groupBy({ by: ["type"], _count: true }),
    getWalletAssetSnapshot(getAddress(config.BASE_WALLET_ADDRESS)).catch(() => null)
  ]);

  const txCount = counts.reduce<Record<TransactionType, number>>(
    (acc, item) => ({ ...acc, [item.type]: item._count }),
    {
      deposit: 0,
      withdrawal: 0,
      lp_increase: 0,
      lp_decrease: 0,
      lp_collect: 0,
      lp_exit: 0,
      lp_deposit: 0,
      swap: 0,
      unknown: 0
    }
  );
  const outOfRangeCount = positions.filter((position) => position.status === "above_range" || position.status === "below_range").length;
  const approvalsByTransactionId = mapApprovalsToTransactions(transactions);
  const visibleTransactions = transactions.filter((transaction) => !isApprovalTransaction(transaction));
  const transactionLpStates = new Map<string, { weth: number | null; usdc: number | null }>();
  const transactionAssetStates = new Map<string, WalletAssetSnapshot>();
  let chronologicalLpAssets: LpAssetAmounts = { weth: 0, usdc: 0 };
  let runningAssets = snapshotToAmounts(walletAssets);
  const tokenPrices = { ethPriceUsd: walletAssets?.ethPriceUsd ?? null, aeroPriceUsd: walletAssets?.aeroPriceUsd ?? null };
  const transactionAeroPrices = new Map<string, number | null>();
  let historicalAeroPriceUsd: number | null = null;

  for (const transaction of [...transactions].reverse()) {
    chronologicalLpAssets = getNextLpAssetAmounts(chronologicalLpAssets, transaction);
    transactionLpStates.set(transaction.id, chronologicalLpAssets);

    const transactionAeroPriceUsd = impliedAeroPriceUsd(transaction.tokenAmounts);
    if (transactionAeroPriceUsd !== null) historicalAeroPriceUsd = transactionAeroPriceUsd;
    transactionAeroPrices.set(transaction.id, historicalAeroPriceUsd);
  }

  for (const transaction of transactions) {
    const lpAssets = transactionLpStates.get(transaction.id) ?? { weth: 0, usdc: 0 };
    const transactionAeroPriceUsd = transactionAeroPrices.get(transaction.id) ?? null;
    transactionAssetStates.set(transaction.id, amountsToPortfolioSnapshot(runningAssets, lpAssets, tokenPrices.ethPriceUsd, transactionAeroPriceUsd));
    runningAssets = subtractDelta(runningAssets, getTransactionAssetDelta(transaction, getAddress(config.BASE_WALLET_ADDRESS)));
  }

  return (
    <main className="page">
      <div className="shell">
        <header className="topbar">
          <div className="brand">
            <div className="mark">WB</div>
            <div>
              <h1>WalletBot</h1>
              <p>
                Base wallet {shortAddress(config.BASE_WALLET_ADDRESS)} · WETH/USDC Uniswap v3
              </p>
            </div>
          </div>
          <div className="actions">
            <form action={runSyncAction}>
              <button className="button primary" type="submit">
                Sync now
              </button>
            </form>
            <form action={logoutAction}>
              <button className="button" type="submit">
                Log out
              </button>
            </form>
          </div>
        </header>

        <section className="grid">
          <div className="panel stat">
            <span>Last synced block</span>
            <strong>{wallet?.lastSyncedBlock?.toString() ?? "Never"}</strong>
          </div>
          <div className="panel stat">
            <span>Positions</span>
            <strong>{positions.length}</strong>
          </div>
          <div className="panel stat">
            <span>Out of range</span>
            <strong>{outOfRangeCount}</strong>
          </div>
          <div className="panel stat">
            <span>LP operations</span>
            <strong>{txCount.lp_increase + txCount.lp_decrease + txCount.lp_collect + txCount.lp_exit + txCount.lp_deposit}</strong>
          </div>
        </section>

        <section className="panel section">
          <div className="section-head">
            <div>
              <h2>Sync status</h2>
              <p className="muted">Polling worker imports wallet activity and refreshes position range state.</p>
            </div>
            {latestRun ? <span className={`status ${statusClass(latestRun.status)}`}>{latestRun.status}</span> : <span className="status">not started</span>}
          </div>
          {latestRun ? (
            <p className="muted">
              Started {latestRun.startedAt.toLocaleString()} · seen {latestRun.transactionsSeen} tx
              {latestRun.error ? ` · ${latestRun.error}` : ""}
            </p>
          ) : null}
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
                  <th>Current tick</th>
                  <th>Range</th>
                  <th>Fee</th>
                  <th>Liquidity</th>
                  <th>Pool</th>
                </tr>
              </thead>
              <tbody>
                {positions.length === 0 ? (
                  <tr>
                    <td colSpan={7}>No positions found yet.</td>
                  </tr>
                ) : (
                  positions.map((position) => (
                    <tr key={position.id}>
                      <td>#{position.tokenId}</td>
                      <td>
                        <span className={`status ${statusClass(position.status)}`}>{position.status}</span>
                      </td>
                      <td>{position.currentTick ?? "-"}</td>
                      <td>
                        {position.tickLower} - {position.tickUpper}
                      </td>
                      <td>{position.fee / 10000}%</td>
                      <td>{position.liquidity}</td>
                      <td>{shortAddress(position.poolAddress)}</td>
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
          <div className="table-wrap transactions-wrap">
            <table className="transactions-table">
              <colgroup>
                <col className="tx-col-time" />
                <col className="tx-col-type" />
                <col className="tx-col-amounts" />
                <col className="tx-col-protocol" />
                <col className="tx-col-position" />
                <col className="tx-col-status" />
                <col className="tx-col-hash" />
                <col className="tx-col-asset" span={5} />
                <col className="tx-col-total" />
              </colgroup>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Type</th>
                  <th>Amounts</th>
                  <th>Protocol</th>
                  <th>Position</th>
                  <th>Status</th>
                  <th>Tx</th>
                  <th>Wallet WETH</th>
                  <th>Wallet USDC</th>
                  <th>Wallet ETH</th>
                  <th>LP WETH</th>
                  <th>LP USDC</th>
                  <th>Wallet total</th>
                </tr>
              </thead>
              <tbody>
                {visibleTransactions.length === 0 ? (
                  <tr>
                    <td colSpan={13}>No transactions imported yet.</td>
                  </tr>
                ) : (
                  visibleTransactions.map((transaction) => {
                    const assetState = transactionAssetStates.get(transaction.id);
                    const approvals = approvalsByTransactionId.get(transaction.id) ?? [];
                    const transactionPrices = {
                      ethPriceUsd: tokenPrices.ethPriceUsd,
                      aeroPriceUsd: impliedAeroPriceUsd(transaction.tokenAmounts) ?? transactionAeroPrices.get(transaction.id) ?? null
                    };

                    return (
                      <tr key={transaction.id}>
                        <td>{transaction.timestamp.toLocaleString()}</td>
                        <td>{transaction.type}</td>
                        <td>{tokenAmountRows(transaction.tokenAmounts, transactionPrices)}</td>
                        <td>{transaction.protocol ?? "-"}</td>
                        <td>{transaction.relatedPositionTokenId ? `#${transaction.relatedPositionTokenId}` : "-"}</td>
                        <td>
                          <div className="tx-stack">
                            <span className={`status ${statusClass(transaction.classificationStatus)}`}>{transaction.classificationStatus}</span>
                            {approvals.map((approval) => (
                              <span className="status approved" key={approval.hash}>
                                approved
                              </span>
                            ))}
                          </div>
                        </td>
                        <td>
                          <div className="tx-stack">
                            <a href={`${EXPLORER_TX_URL}${transaction.hash}`} target="_blank" rel="noreferrer">
                              {shortAddress(transaction.hash)}
                            </a>
                            {approvals.map((approval) => (
                              <a href={`${EXPLORER_TX_URL}${approval.hash}`} target="_blank" rel="noreferrer" key={approval.hash}>
                                {shortAddress(approval.hash)}
                              </a>
                            ))}
                          </div>
                        </td>
                        <td>{walletAssetCell(assetState?.weth)}</td>
                        <td>{walletAssetCell(assetState?.usdc)}</td>
                        <td>{walletAssetCell(assetState?.eth)}</td>
                        <td>{walletAssetCell(assetState?.lpWeth)}</td>
                        <td>{walletAssetCell(assetState?.lpUsdc)}</td>
                        <td className="total-cell">{formatUsd(assetState?.totalUsd)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
