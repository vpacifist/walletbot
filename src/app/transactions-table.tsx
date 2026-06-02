"use client";

import { useEffect, useMemo, useState } from "react";
import { EXPLORER_TX_URL } from "@/lib/constants";
import { formatNumber, shortAddress } from "@/lib/format";
import type { HistoricalPricesByBlock } from "@/lib/historical-prices";
import { impliedAeroPriceUsd, portfolioTotalUsd } from "@/lib/performance";

export type TransactionTableRow = {
  id: string;
  hash: string;
  blockNumber: string;
  timestamp: string;
  type: string;
  displayType?: string;
  tokenAmounts: unknown;
  protocol: string | null;
  relatedPositionTokenId: string | null;
  classificationStatus: string;
  approvals: Array<{ hash: string }>;
  rebalanceDetails?: {
    closed: Array<{ tokenId: string; weth: number | null; usdc: number | null }>;
    minted: Array<{ tokenId: string; weth: number | null; usdc: number | null }>;
    earned: Array<{ tokenId: string; weth: number | null; usdc: number | null }>;
    boundaryDrift?: {
      side: "sell_weth" | "buy_weth";
      boundaryPrice: number;
      executionPrice: number;
      wethAmount: number;
      costUsd: number;
    } | null;
  } | null;
  assets: {
    weth: number | null;
    usdc: number | null;
    aero: number | null;
    eth: number | null;
    lpWeth: number | null;
    lpUsdc: number | null;
  };
};

type TransactionsTableProps = {
  rows: TransactionTableRow[];
  initialPrices: HistoricalPricesByBlock;
};

function statusClass(status: string) {
  if (status === "in_range" || status === "succeeded" || status === "classified") return "good";
  if (status === "below_range" || status === "above_range" || status === "partial") return "warn";
  if (status === "failed") return "bad";
  return "";
}

function formatUsd(value?: number | null) {
  if (value === undefined) return <span className="price-placeholder">loading</span>;
  if (value === null) return "-";
  return `$${formatNumber(value, 2)}`;
}

function formatPercentChange(value?: number | null) {
  if (value === undefined || value === null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  const roundedValue = Object.is(rounded, -0) ? 0 : rounded;
  const sign = roundedValue > 0 ? "+" : "";
  const direction = roundedValue > 0 ? "positive" : roundedValue < 0 ? "negative" : "neutral";
  const formattedValue = new Intl.NumberFormat("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(roundedValue);

  return (
    <span className={`percent-change ${direction}`}>
      {sign}
      {formattedValue}%
    </span>
  );
}

function percentChange(current?: number | null, previous?: number | null) {
  if (current === undefined || previous === undefined) return undefined;
  if (current === null || previous === null || previous === 0) return null;
  return ((current - previous) / previous) * 100;
}

function formatSignedUsd(sign: string, value?: number | null) {
  if (value === undefined) return <span className="price-placeholder">loading</span>;
  if (value === null) return "-";
  return `${sign}$${formatNumber(value, 2)}`;
}

function tokenAmountUsd(amount: { amount?: string; symbol?: string }, prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }) {
  const numericAmount = Number(amount.amount);
  if (!Number.isFinite(numericAmount)) return null;
  if (amount.symbol === "USDC") return numericAmount;
  if ((amount.symbol === "WETH" || amount.symbol === "ETH") && prices?.ethPriceUsd !== undefined) {
    return prices.ethPriceUsd === null ? null : numericAmount * prices.ethPriceUsd;
  }
  if (amount.symbol === "AERO" && prices?.aeroPriceUsd !== undefined) {
    return prices.aeroPriceUsd === null ? null : numericAmount * prices.aeroPriceUsd;
  }
  return undefined;
}

function tokenAmountRows(value: unknown, prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }) {
  if (!Array.isArray(value) || value.length === 0) return "-";
  const rows = value
    .map((item, index) => {
      if (!item || typeof item !== "object") return null;
      const amount = item as { direction?: string; amount?: string; symbol?: string };
      const sign = amount.direction === "out" ? "-" : "+";
      const usdValue = tokenAmountUsd(amount, prices);

      return (
        <div className="amount-row" key={`${amount.symbol ?? "token"}-${index}`}>
          <span>
            {sign}
            {formatNumber(amount.amount, 6)} {amount.symbol ?? ""}
          </span>
          <span>{formatSignedUsd(sign, usdValue)}</span>
        </div>
      );
    })
    .filter(Boolean);

  if (rows.length === 0) return "-";
  return <div className="amounts-cell">{rows}</div>;
}

function compactLpAmounts(amounts: { weth: number | null; usdc: number | null }) {
  const parts = [];
  if (amounts.weth !== null && Math.abs(amounts.weth) > 0) parts.push(`${formatNumber(amounts.weth, 6)} WETH`);
  if (amounts.usdc !== null && Math.abs(amounts.usdc) > 0) parts.push(`${formatNumber(amounts.usdc, 2)} USDC`);
  return parts.length > 0 ? parts.join(" + ") : "0";
}

function compactTokenAmounts(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) return "0";
  const parts = value
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const amount = item as { amount?: string; symbol?: string };
      if (!amount.symbol) return null;
      return `${formatNumber(amount.amount, amount.symbol === "USDC" ? 2 : 6)} ${amount.symbol}`;
    })
    .filter(Boolean);

  return parts.length > 0 ? parts.join(" + ") : "0";
}

function lpValueUsd(amounts: { weth: number | null; usdc: number | null }, prices?: { ethPriceUsd?: number | null }) {
  if (prices?.ethPriceUsd === undefined) return undefined;
  if (prices.ethPriceUsd === null) return null;
  return (amounts.weth ?? 0) * prices.ethPriceUsd + (amounts.usdc ?? 0);
}

function tokenAmountsValueUsd(value: unknown, prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }) {
  if (!Array.isArray(value)) return 0;

  return value.reduce<number | null | undefined>((total, item) => {
    if (total === undefined || total === null) return total;
    if (!item || typeof item !== "object") return total;
    const amount = item as { amount?: string; symbol?: string };
    const usdValue = tokenAmountUsd(amount, prices);
    if (usdValue === undefined || usdValue === null) return usdValue;
    return total + usdValue;
  }, 0);
}

function sumLpValueUsd(items: Array<{ weth: number | null; usdc: number | null }>, prices?: { ethPriceUsd?: number | null }) {
  return items.reduce<number | null | undefined>((total, item) => {
    if (total === undefined || total === null) return total;
    const value = lpValueUsd(item, prices);
    if (value === undefined || value === null) return value;
    return total + value;
  }, 0);
}

function rebalanceCostUsd(
  rebalanceDetails: NonNullable<TransactionTableRow["rebalanceDetails"]>,
  leftovers: unknown,
  prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }
) {
  const closedValue = sumLpValueUsd(rebalanceDetails.closed, prices);
  const mintedValue = sumLpValueUsd(rebalanceDetails.minted, prices);
  const earnedValue = sumLpValueUsd(rebalanceDetails.earned, prices);
  const leftoverValue = tokenAmountsValueUsd(leftovers, prices);

  if (
    closedValue === undefined ||
    mintedValue === undefined ||
    earnedValue === undefined ||
    leftoverValue === undefined
  ) {
    return undefined;
  }
  if (closedValue === null || mintedValue === null || earnedValue === null || leftoverValue === null) return null;

  return closedValue + earnedValue - mintedValue - leftoverValue;
}

function boundaryDriftLabel(drift: NonNullable<NonNullable<TransactionTableRow["rebalanceDetails"]>["boundaryDrift"]>) {
  const verb = drift.side === "sell_weth" ? "sold" : "bought";
  return `${verb} ${formatNumber(drift.wethAmount, 6)} WETH @ ${formatUsd(drift.executionPrice)} vs ${formatUsd(drift.boundaryPrice)} boundary`;
}

function rebalanceAmountRows(
  rebalanceDetails: NonNullable<TransactionTableRow["rebalanceDetails"]>,
  leftovers: unknown,
  prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }
) {
  const fromTokenId = rebalanceDetails.closed[0]?.tokenId;
  const toTokenId = rebalanceDetails.minted[0]?.tokenId;
  const costUsd = rebalanceCostUsd(rebalanceDetails, leftovers, prices);

  return (
    <div className="rebalance-summary">
      <strong>
        #{fromTokenId ?? "?"} -&gt; #{toTokenId ?? "?"}
      </strong>
      <span className="rebalance-cost">Cost {formatUsd(costUsd)}</span>
      {rebalanceDetails.boundaryDrift ? (
        <span className="historical-note">Boundary drift {formatUsd(rebalanceDetails.boundaryDrift.costUsd)}</span>
      ) : null}
      {rebalanceDetails.boundaryDrift ? <span className="historical-note">{boundaryDriftLabel(rebalanceDetails.boundaryDrift)}</span> : null}
      {rebalanceDetails.closed[0] ? <span>Closed {compactLpAmounts(rebalanceDetails.closed[0])}</span> : null}
      {rebalanceDetails.minted[0] ? <span>Minted {compactLpAmounts(rebalanceDetails.minted[0])}</span> : null}
      {rebalanceDetails.earned[0] ? <span>Fees {compactLpAmounts(rebalanceDetails.earned[0])}</span> : null}
      <span className="historical-note">Leftover {compactTokenAmounts(leftovers)}</span>
    </div>
  );
}

function assetValueUsd(
  symbol: "WETH" | "USDC" | "AERO" | "ETH",
  amount: number | null,
  prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }
) {
  if (amount === null) return null;
  if (symbol === "USDC") return amount;
  if (symbol === "AERO") {
    if (prices?.aeroPriceUsd === undefined || prices.aeroPriceUsd === null) return undefined;
    return amount * prices.aeroPriceUsd;
  }
  if (prices?.ethPriceUsd === undefined) return undefined;
  if (prices.ethPriceUsd === null) return null;
  return amount * prices.ethPriceUsd;
}

function walletAssetCell(
  symbol: "WETH" | "USDC" | "AERO" | "ETH",
  amount: number | null,
  prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }
) {
  if (amount === null) return "-";
  const amountDigits = symbol === "USDC" ? 2 : 6;
  const valueUsd = assetValueUsd(symbol, amount, prices);

  return (
    <div className="asset-cell">
      <strong>{formatNumber(amount, amountDigits)}</strong>
      <span>{formatUsd(valueUsd)}</span>
    </div>
  );
}

function walletTotalCell(value?: number | null, previousValue?: number | null) {
  const change = formatPercentChange(percentChange(value, previousValue));

  return (
    <div className="asset-cell total-asset-cell">
      <strong>{formatUsd(value)}</strong>
      {change}
    </div>
  );
}

function wethPriceCell(value?: number | null, previousValue?: number | null) {
  const change = formatPercentChange(percentChange(value, previousValue));

  return (
    <div className="asset-cell">
      <strong>{formatUsd(value)}</strong>
      {change}
    </div>
  );
}

export function TransactionsTable({ rows, initialPrices }: TransactionsTableProps) {
  const [prices, setPrices] = useState(initialPrices);
  const blockNumbers = useMemo(() => [...new Set(rows.map((row) => row.blockNumber))], [rows]);

  useEffect(() => {
    const missingBlockNumbers = blockNumbers.filter((blockNumber) => {
      const blockPrices = prices[blockNumber];
      return blockPrices?.ethPriceUsd === undefined || blockPrices?.aeroPriceUsd === undefined;
    });
    if (missingBlockNumbers.length === 0) return;

    const controller = new AbortController();
    void fetch("/api/prices/historical", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ blockNumbers: missingBlockNumbers }),
      signal: controller.signal
    })
      .then((response) => (response.ok ? response.json() : Promise.reject(new Error("Failed to load historical prices"))))
      .then((payload: { prices: HistoricalPricesByBlock }) => {
        setPrices((current) => ({ ...current, ...payload.prices }));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [blockNumbers, prices]);

  return (
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
          <col className="tx-col-asset" span={4} />
          <col className="tx-col-total" />
          <col className="tx-col-weth-price" />
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
            <th>LP WETH</th>
            <th>LP USDC</th>
            <th>Wallet total</th>
            <th>WETH price</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={13}>No transactions imported yet.</td>
            </tr>
          ) : (
            rows.map((transaction, index) => {
              const blockPrices = prices[transaction.blockNumber] ?? {};
              const transactionPrices = {
                ethPriceUsd: blockPrices.ethPriceUsd,
                aeroPriceUsd: impliedAeroPriceUsd(transaction.type, transaction.tokenAmounts) ?? blockPrices.aeroPriceUsd
              };
              const previousTransaction = rows[index + 1];
              const previousBlockPrices = previousTransaction ? prices[previousTransaction.blockNumber] ?? {} : undefined;
              const previousPrices = previousBlockPrices
                ? {
                    ethPriceUsd: previousBlockPrices.ethPriceUsd,
                    aeroPriceUsd:
                      impliedAeroPriceUsd(previousTransaction.type, previousTransaction.tokenAmounts) ?? previousBlockPrices.aeroPriceUsd
                  }
                : undefined;
              const currentWalletTotal = portfolioTotalUsd(transaction, transactionPrices);
              const previousWalletTotal = previousTransaction ? portfolioTotalUsd(previousTransaction, previousPrices) : null;

              return (
                <tr key={transaction.id}>
                  <td>{new Date(transaction.timestamp).toLocaleString()}</td>
                  <td>{transaction.displayType ?? transaction.type}</td>
                  <td>
                    {transaction.rebalanceDetails
                      ? rebalanceAmountRows(transaction.rebalanceDetails, transaction.tokenAmounts, transactionPrices)
                      : tokenAmountRows(transaction.tokenAmounts, transactionPrices)}
                  </td>
                  <td>{transaction.protocol ?? "-"}</td>
                  <td>{transaction.relatedPositionTokenId ? `#${transaction.relatedPositionTokenId}` : "-"}</td>
                  <td>
                    <div className="tx-stack">
                      <span className={`status ${statusClass(transaction.classificationStatus)}`}>{transaction.classificationStatus}</span>
                      {transaction.approvals.map((approval) => (
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
                      {transaction.approvals.map((approval) => (
                        <a href={`${EXPLORER_TX_URL}${approval.hash}`} target="_blank" rel="noreferrer" key={approval.hash}>
                          {shortAddress(approval.hash)}
                        </a>
                      ))}
                    </div>
                  </td>
                  <td>{walletAssetCell("WETH", transaction.assets.weth, transactionPrices)}</td>
                  <td>{walletAssetCell("USDC", transaction.assets.usdc, transactionPrices)}</td>
                  <td>{walletAssetCell("WETH", transaction.assets.lpWeth, transactionPrices)}</td>
                  <td>{walletAssetCell("USDC", transaction.assets.lpUsdc, transactionPrices)}</td>
                  <td>{walletTotalCell(currentWalletTotal, previousWalletTotal)}</td>
                  <td>{wethPriceCell(transactionPrices.ethPriceUsd, previousPrices?.ethPriceUsd ?? null)}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
