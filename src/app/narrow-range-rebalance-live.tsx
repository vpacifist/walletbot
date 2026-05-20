"use client";

import { useEffect, useMemo, useState } from "react";

type RebalanceData = {
  wallet: {
    weth: number | null;
    usdc: number | null;
  };
  pool: {
    address: string;
    fee: number;
    tickSpacing: number;
    currentTick: number;
    lowerTick: number;
    upperTick: number;
    price: number;
    lowerPrice: number;
    upperPrice: number;
    widthPercent: number;
  };
  target: {
    weth: number;
    usdc: number;
    wethValueUsd: number;
    usdcValueUsd: number;
    totalValueUsd: number;
    usdcPerWethRatio: number;
  };
  swap: {
    direction: "weth_to_usdc" | "usdc_to_weth" | "none" | "unavailable";
    spendSymbol: "WETH" | "USDC" | null;
    spendAmount: number | null;
    receiveSymbol: "WETH" | "USDC" | null;
    idealReceiveAmount: number | null;
    reason: string | null;
  };
  updatedAt: string;
};

function formatAmount(value: number | null | undefined, digits: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { maximumFractionDigits: 2, style: "currency", currency: "USD" });
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `${value.toLocaleString(undefined, { maximumFractionDigits: 3 })}%`;
}

function formatSignedPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
}

function actionText(data: RebalanceData | null) {
  if (!data) return "Loading";
  if (data.swap.direction === "unavailable") return data.swap.reason ?? "Unavailable";
  if (data.swap.direction === "none") return "No swap needed";
  return `Swap ${formatAmount(data.swap.spendAmount, data.swap.spendSymbol === "USDC" ? 2 : 6)} ${data.swap.spendSymbol}`;
}

function receiveText(data: RebalanceData | null) {
  if (!data) return "-";
  if (data.swap.direction === "unavailable") return "-";
  if (data.swap.direction === "none") return "0";
  return `${formatAmount(data.swap.idealReceiveAmount, data.swap.receiveSymbol === "USDC" ? 2 : 6)} ${data.swap.receiveSymbol}`;
}

function priceOffsetPercent(price: number | null | undefined, boundaryPrice: number | null | undefined) {
  if (!price || !boundaryPrice || !Number.isFinite(price) || !Number.isFinite(boundaryPrice)) return null;
  return (boundaryPrice / price - 1) * 100;
}

export function NarrowRangeRebalanceLive() {
  const [data, setData] = useState<RebalanceData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch("/api/rebalance", { cache: "no-store" });
        const payload = (await response.json()) as RebalanceData | { error?: string };
        if (!active) return;

        if (!response.ok) {
          setError("error" in payload && payload.error ? payload.error : "Unable to load rebalance");
          return;
        }

        setData(payload as RebalanceData);
        setError(null);
      } catch {
        if (active) setError("Unable to load rebalance");
      } finally {
        if (active) timeoutId = setTimeout(poll, 60_000);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, []);

  const swapClass = useMemo(() => {
    if (!data) return "";
    if (data.swap.direction === "unavailable") return "bad";
    if (data.swap.direction === "none") return "good";
    return "warn";
  }, [data]);

  return (
    <div className="rebalance-grid">
      <div className="rebalance-primary">
        <div className={`hero-metric ${swapClass}`}>
          <p className="metric-label">Swap</p>
          <strong>{actionText(data)}</strong>
          <p className="muted">Spend amount to rebalance the wallet before adding liquidity.</p>
        </div>
        <div className="hero-metric">
          <p className="metric-label">Ideal receive</p>
          <strong>{receiveText(data)}</strong>
          <p className="muted">Use this as the expected output guard before confirming the swap.</p>
        </div>
      </div>

      <div className="metric-list">
        <div>
          <p className="metric-label">Wallet</p>
          <strong>{formatAmount(data?.wallet.weth, 6)} WETH</strong>
          <span>{formatAmount(data?.wallet.usdc, 2)} USDC</span>
        </div>
        <div>
          <p className="metric-label">Target after swap</p>
          <strong>{formatAmount(data?.target.weth, 6)} WETH</strong>
          <span>{formatAmount(data?.target.usdc, 2)} USDC</span>
        </div>
        <div>
          <p className="metric-label">Range</p>
          <div className="range-prices">
            <div>
              <span>Min price</span>
              <strong>{formatAmount(data?.pool.lowerPrice, 4)}</strong>
              <small>{formatSignedPercent(priceOffsetPercent(data?.pool.price, data?.pool.lowerPrice))}</small>
            </div>
            <div>
              <span>Max price</span>
              <strong>{formatAmount(data?.pool.upperPrice, 4)}</strong>
              <small>{formatSignedPercent(priceOffsetPercent(data?.pool.price, data?.pool.upperPrice))}</small>
            </div>
          </div>
          <span>{formatPercent(data?.pool.widthPercent)} width</span>
        </div>
        <div>
          <p className="metric-label">WETH price</p>
          <strong>{formatUsd(data?.pool.price)}</strong>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
