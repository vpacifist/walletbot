"use client";

import { useState } from "react";
import { PriceRangeVisual } from "./price-range-visual";

export type PositionTableRow = {
  id: string;
  tokenId: string;
  status: string;
  statusClassName: string;
  statusLabel: string;
  isClosed: boolean;
  date: string;
  timeInRange: string;
  priceRange: {
    lowerExtendedPrice: number | null;
    lowerPrice: number | null;
    upperPrice: number | null;
    upperExtendedPrice: number | null;
    currentPrice: number | null;
    lowerLabel: string;
    upperLabel: string;
    rangeCount: number;
    livePriceEndpoint?: string;
  };
  positionAmounts: {
    weth: string;
    usdc: string;
    note: string | null;
  };
  deposit: {
    total: string;
    wethUsd: string;
    usdcUsd: string;
    note: string | null;
  };
  earned: {
    total: string;
    weth: string;
    usdc: string;
    note: string | null;
  };
  total: string;
  totalNote: string | null;
  dpr: {
    dpr: string;
    apr: string;
  } | null;
  pnl: {
    value: string;
    className: string;
    note: string;
  };
  pool: {
    fee: string;
    address: string;
    url: string | null;
  };
};

type PositionsTableProps = {
  rows: PositionTableRow[];
};

export function PositionsTable({ rows }: PositionsTableProps) {
  return (
    <div className="table-wrap positions-wrap">
      <table className="positions-table">
        <colgroup>
          <col className="position-col-token" />
          <col className="position-col-status" />
          <col className="position-col-date" />
          <col className="position-col-time-range" />
          <col className="position-col-range" />
          <col className="position-col-amounts" />
          <col className="position-col-deposit" />
          <col className="position-col-earned" />
          <col className="position-col-total" />
          <col className="position-col-dpr" />
          <col className="position-col-pnl" />
          <col className="position-col-pool" />
        </colgroup>
        <thead>
          <tr>
            <th>Token ID</th>
            <th>Status</th>
            <th>Date</th>
            <th>Time in range</th>
            <th>Price range</th>
            <th>Position</th>
            <th>Deposit</th>
            <th>Earned</th>
            <th>Total</th>
            <th>DPR</th>
            <th>PnL</th>
            <th>Pool</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={12}>No positions found yet.</td>
            </tr>
          ) : (
            rows.map((position) => <PositionTableRowView key={position.id} position={position} />)
          )}
        </tbody>
      </table>
    </div>
  );
}

function PositionTableRowView({ position }: { position: PositionTableRow }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const rowClassName = [
    position.isClosed ? "position-row-closed" : "",
    position.isClosed ? "position-row-collapsible" : "",
    isExpanded ? "is-expanded" : ""
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <tr
      className={rowClassName || undefined}
      tabIndex={position.isClosed ? 0 : undefined}
      onClick={(event) => {
        if (!position.isClosed) return;
        if ((event.target as HTMLElement).closest("a")) return;
        setIsExpanded((current) => !current);
      }}
      onKeyDown={(event) => {
        if (!position.isClosed) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        setIsExpanded((current) => !current);
      }}
      aria-expanded={position.isClosed ? isExpanded : undefined}
      aria-label={position.isClosed ? `Toggle closed position ${position.tokenId}` : undefined}
    >
      <td>
        <div className="token-cell">
          <span className="token-id-line">
            {position.isClosed ? <span className="row-expand-marker" aria-hidden="true" /> : null}
            <span>#{position.tokenId}</span>
          </span>
        </div>
      </td>
      <td>
        <span className={`status ${position.statusClassName}`}>{position.statusLabel}</span>
      </td>
      <td className="position-date-cell">{position.date}</td>
      <td className="position-time-range-cell">{position.timeInRange}</td>
      <td className="position-full-cell">
        <div className="price-range-cell">
          <PriceRangeVisual {...position.priceRange} />
        </div>
      </td>
      <td className="position-full-cell">
        <div className="asset-cell position-amounts">
          <span>{position.positionAmounts.weth} WETH</span>
          <span>{position.positionAmounts.usdc} USDC</span>
          {position.positionAmounts.note ? <span className="historical-note">{position.positionAmounts.note}</span> : null}
        </div>
      </td>
      <td>
        <div className="asset-cell deposit-cell">
          <strong>{position.deposit.total}</strong>
          <span className="deposit-parts position-detail-lines">
            <span>{position.deposit.wethUsd}</span>
            <span>+ {position.deposit.usdcUsd}</span>
            {position.deposit.note ? <span className="historical-note">{position.deposit.note}</span> : null}
          </span>
        </div>
      </td>
      <td>
        <div className="asset-cell">
          <strong>{position.earned.total}</strong>
          <span className="position-detail-lines">{position.earned.weth} WETH</span>
          <span className="position-detail-lines">{position.earned.usdc} USDC</span>
          {position.earned.note ? <span className="historical-note position-detail-lines">{position.earned.note}</span> : null}
        </div>
      </td>
      <td>
        <div className="asset-cell">
          <strong className="total-cell">{position.total}</strong>
          {position.totalNote ? <span className="historical-note">{position.totalNote}</span> : null}
        </div>
      </td>
      <td>
        {position.dpr ? (
          <span className="dpr-cell">
            <span>{position.dpr.dpr}</span>
            <span>{position.dpr.apr}</span>
          </span>
        ) : (
          "-"
        )}
      </td>
      <td>
        <div className={`asset-cell pnl-cell ${position.pnl.className}`}>
          <strong>{position.pnl.value}</strong>
          <span>{position.pnl.note}</span>
        </div>
      </td>
      <td>
        <div className="pool-cell">
          <strong>{position.pool.fee}</strong>
          {position.pool.url ? (
            <a className="pool-link" href={position.pool.url} target="_blank" rel="noreferrer">
              {position.pool.address}
            </a>
          ) : (
            <span>{position.pool.address}</span>
          )}
        </div>
      </td>
    </tr>
  );
}
