"use client";

import { useEffect, useMemo, useState } from "react";
import { EXPLORER_TX_URL } from "@/lib/constants";
import { formatNumber, shortAddress } from "@/lib/format";
import type { HistoricalPricesByBlock } from "@/lib/historical-prices";

export type TransactionTableRow = {
  id: string;
  hash: string;
  blockNumber: string;
  timestamp: string;
  type: string;
  tokenAmounts: unknown;
  protocol: string | null;
  relatedPositionTokenId: string | null;
  classificationStatus: string;
  approvals: Array<{ hash: string }>;
  assets: {
    weth: number | null;
    usdc: number | null;
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
  if (value === undefined || value === null) return <span className="price-placeholder">loading</span>;
  return `$${formatNumber(value, 2)}`;
}

function formatSignedUsd(sign: string, value?: number | null) {
  if (value === undefined || value === null) return <span className="price-placeholder">loading</span>;
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

function impliedAeroPriceUsd(type: string, value: unknown) {
  if (type !== "swap") return null;
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

function assetValueUsd(symbol: "WETH" | "USDC" | "ETH", amount: number | null, prices?: { ethPriceUsd?: number | null }) {
  if (amount === null) return null;
  if (symbol === "USDC") return amount;
  if (prices?.ethPriceUsd === undefined || prices.ethPriceUsd === null) return undefined;
  return amount * prices.ethPriceUsd;
}

function walletAssetCell(symbol: "WETH" | "USDC" | "ETH", amount: number | null, prices?: { ethPriceUsd?: number | null }) {
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

function totalUsd(row: TransactionTableRow, prices?: { ethPriceUsd?: number | null }) {
  const values = [
    assetValueUsd("WETH", row.assets.weth, prices),
    assetValueUsd("USDC", row.assets.usdc, prices),
    assetValueUsd("ETH", row.assets.eth, prices),
    assetValueUsd("WETH", row.assets.lpWeth, prices),
    assetValueUsd("USDC", row.assets.lpUsdc, prices)
  ];

  if (values.some((value) => value === undefined)) return undefined;
  if (values.every((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
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
          {rows.length === 0 ? (
            <tr>
              <td colSpan={13}>No transactions imported yet.</td>
            </tr>
          ) : (
            rows.map((transaction) => {
              const blockPrices = prices[transaction.blockNumber] ?? {};
              const transactionPrices = {
                ethPriceUsd: blockPrices.ethPriceUsd,
                aeroPriceUsd: impliedAeroPriceUsd(transaction.type, transaction.tokenAmounts) ?? blockPrices.aeroPriceUsd
              };

              return (
                <tr key={transaction.id}>
                  <td>{new Date(transaction.timestamp).toLocaleString()}</td>
                  <td>{transaction.type}</td>
                  <td>{tokenAmountRows(transaction.tokenAmounts, transactionPrices)}</td>
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
                  <td>{walletAssetCell("ETH", transaction.assets.eth, transactionPrices)}</td>
                  <td>{walletAssetCell("WETH", transaction.assets.lpWeth, transactionPrices)}</td>
                  <td>{walletAssetCell("USDC", transaction.assets.lpUsdc, transactionPrices)}</td>
                  <td className="total-cell">{formatUsd(totalUsd(transaction, transactionPrices))}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
