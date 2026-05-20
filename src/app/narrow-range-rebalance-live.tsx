"use client";

import { useEffect, useMemo, useState } from "react";

const RANGE_WIDTH_STORAGE_KEY = "walletbot:weth-usdc-range-width-multiplier";
const RANGE_WIDTH_OPTIONS = [
  { value: 1, label: "0.6" },
  { value: 2, label: "1.2" },
  { value: 3, label: "1.8" },
  { value: 4, label: "2.4" },
  { value: 5, label: "3.0" }
] as const;
type RangeWidthMultiplier = (typeof RANGE_WIDTH_OPTIONS)[number]["value"];

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

function formatPlainAmount(value: number | null | undefined, digits: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, useGrouping: false });
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

function actionText(data: RebalanceData | null, error: string | null) {
  if (error && !data) return error;
  if (!data) return "Loading";
  if (data.swap.direction === "unavailable") return data.swap.reason ?? "Unavailable";
  if (data.swap.direction === "none") return "No swap needed";
  return `${formatPlainAmount(data.swap.spendAmount, data.swap.spendSymbol === "USDC" ? 2 : 6)} ${data.swap.spendSymbol}`;
}

function receiveText(data: RebalanceData | null) {
  if (!data) return "-";
  if (data.swap.direction === "unavailable") return "-";
  if (data.swap.direction === "none") return "0";
  return `${formatPlainAmount(data.swap.idealReceiveAmount, data.swap.receiveSymbol === "USDC" ? 2 : 6)} ${data.swap.receiveSymbol}`;
}

function priceOffsetPercent(price: number | null | undefined, boundaryPrice: number | null | undefined) {
  if (!price || !boundaryPrice || !Number.isFinite(price) || !Number.isFinite(boundaryPrice)) return null;
  return (boundaryPrice / price - 1) * 100;
}

function readStoredRangeWidthMultiplier(): RangeWidthMultiplier {
  if (typeof window === "undefined") return 1;
  const stored = Number(window.localStorage.getItem(RANGE_WIDTH_STORAGE_KEY));
  return RANGE_WIDTH_OPTIONS.some((option) => option.value === stored) ? (stored as RangeWidthMultiplier) : 1;
}

async function writeClipboardText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textArea = document.createElement("textarea");
    textArea.value = text;
    textArea.setAttribute("readonly", "");
    textArea.style.position = "fixed";
    textArea.style.left = "-9999px";
    textArea.style.top = "0";
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    textArea.setSelectionRange(0, text.length);

    try {
      return document.execCommand("copy");
    } finally {
      document.body.removeChild(textArea);
    }
  }
}

export function NarrowRangeRebalanceLive() {
  const [rangeWidthMultiplier, setRangeWidthMultiplier] = useState<RangeWidthMultiplier>(readStoredRangeWidthMultiplier);
  const [data, setData] = useState<RebalanceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const controller = new AbortController();
      const abortId = window.setTimeout(() => controller.abort(), 20_000);

      try {
        const response = await fetch(`/api/rebalance?widthMultiplier=${rangeWidthMultiplier}`, {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal
        });
        const payload = (await response.json()) as RebalanceData | { error?: string };
        if (!active) return;

        if (!response.ok) {
          setError("error" in payload && payload.error ? payload.error : "Unable to load rebalance");
          return;
        }

        setData(payload as RebalanceData);
        setError(null);
      } catch (requestError) {
        if (active) setError(requestError instanceof DOMException && requestError.name === "AbortError" ? "Rebalance request timed out" : "Unable to load rebalance");
      } finally {
        window.clearTimeout(abortId);
        if (active) timeoutId = setTimeout(poll, 60_000);
      }
    };

    void poll();

    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [rangeWidthMultiplier]);

  function selectRangeWidthMultiplier(value: RangeWidthMultiplier) {
    setRangeWidthMultiplier(value);
    window.localStorage.setItem(RANGE_WIDTH_STORAGE_KEY, String(value));
  }

  async function copySwapAmount() {
    if (!data || data.swap.direction === "unavailable" || data.swap.direction === "none") return;
    const amount = formatPlainAmount(data.swap.spendAmount, data.swap.spendSymbol === "USDC" ? 2 : 6);
    const copied = await writeClipboardText(amount);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1200);
  }

  const swapClass = useMemo(() => {
    if (error && !data) return "bad";
    if (!data) return "";
    if (data.swap.direction === "unavailable") return "bad";
    if (data.swap.direction === "none") return "good";
    return "warn";
  }, [data, error]);

  return (
    <div className="rebalance-grid">
      <div className="rebalance-primary">
        <div className={`hero-metric ${swapClass}`}>
          <p className="metric-label">Swap</p>
          <button
            type="button"
            className={`copy-metric ${copyState !== "idle" ? "has-feedback" : ""}`}
            disabled={!data || data.swap.direction === "unavailable" || data.swap.direction === "none"}
            title={copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy swap amount"}
            aria-label={copyState === "copied" ? "Copied swap amount" : copyState === "failed" ? "Copy failed" : "Copy swap amount"}
            onClick={copySwapAmount}
          >
            <strong>{actionText(data, error)}</strong>
            <span className={`copy-feedback ${copyState}`} aria-live="polite">
              {copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy failed" : "Copy"}
            </span>
          </button>
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
        <div className="range-metric">
          <p className="metric-label">Range</p>
          <div className="range-prices">
            <div>
              <span>Min price</span>
              <strong>{formatAmount(data?.pool.lowerPrice, 4)}</strong>
              <small>{formatSignedPercent(priceOffsetPercent(data?.pool.price, data?.pool.lowerPrice))}</small>
            </div>
            <div>
              <span>Current price</span>
              <strong>{formatAmount(data?.pool.price, 4)}</strong>
              <small>0%</small>
            </div>
            <div>
              <span>Max price</span>
              <strong>{formatAmount(data?.pool.upperPrice, 4)}</strong>
              <small>{formatSignedPercent(priceOffsetPercent(data?.pool.price, data?.pool.upperPrice))}</small>
            </div>
          </div>
        </div>
        <div className="range-width-metric">
          <p className="metric-label">Width</p>
          <div className="range-width-buttons" role="group" aria-label="Range width">
            {RANGE_WIDTH_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                className={option.value === rangeWidthMultiplier ? "is-active" : undefined}
                aria-pressed={option.value === rangeWidthMultiplier}
                title={`${option.label}% range width`}
                onClick={() => selectRangeWidthMultiplier(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
          <span>{formatPercent(data?.pool.widthPercent)} width</span>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
