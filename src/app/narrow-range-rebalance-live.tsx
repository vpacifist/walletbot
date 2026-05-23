"use client";

import { useEffect, useMemo, useState } from "react";

const RANGE_WIDTH_STORAGE_KEY = "walletbot:weth-usdc-range-width-multiplier";
const MAX_RANGE_EXTENSION_INTERVALS = 4;

type RangeSelection = {
  lowerExtensionIntervals: number;
  upperExtensionIntervals: number;
};

const DEFAULT_RANGE_SELECTION: RangeSelection = { lowerExtensionIntervals: 0, upperExtensionIntervals: 0 };

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
  return value.toLocaleString("en-US", { maximumFractionDigits: digits, minimumFractionDigits: 0, useGrouping: false });
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

function readStoredRangeSelection(): RangeSelection {
  if (typeof window === "undefined") return DEFAULT_RANGE_SELECTION;
  const stored = window.localStorage.getItem(RANGE_WIDTH_STORAGE_KEY);
  if (!stored) return DEFAULT_RANGE_SELECTION;

  try {
    const parsed = JSON.parse(stored) as Partial<RangeSelection>;
    const lowerExtensionIntervals = clampRangeExtension(parsed.lowerExtensionIntervals);
    const upperExtensionIntervals = clampRangeExtension(parsed.upperExtensionIntervals);
    return { lowerExtensionIntervals, upperExtensionIntervals };
  } catch {
    return DEFAULT_RANGE_SELECTION;
  }
}

function clampRangeExtension(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(MAX_RANGE_EXTENSION_INTERVALS, Math.max(0, Math.round(parsed)));
}

function rangeSelectionStorageValue(selection: RangeSelection) {
  return JSON.stringify(selection);
}

function rangeScaleSegments(selection: RangeSelection) {
  const segments = [];
  for (let index = MAX_RANGE_EXTENSION_INTERVALS; index > 0; index -= 1) {
    segments.push({ key: `lower-${index}`, active: index <= selection.lowerExtensionIntervals, tone: "lower" });
  }
  segments.push({ key: "active", active: true, tone: "active" });
  for (let index = 1; index <= MAX_RANGE_EXTENSION_INTERVALS; index += 1) {
    segments.push({ key: `upper-${index}`, active: index <= selection.upperExtensionIntervals, tone: "upper" });
  }
  return segments;
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
  const [rangeSelection, setRangeSelection] = useState<RangeSelection>(DEFAULT_RANGE_SELECTION);
  const [data, setData] = useState<RebalanceData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const [priceCopyState, setPriceCopyState] = useState<"idle" | "min" | "max" | "failed">("idle");

  useEffect(() => {
    setRangeSelection(readStoredRangeSelection());
  }, []);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const controller = new AbortController();
      const abortId = window.setTimeout(() => controller.abort(), 20_000);

      try {
        const params = new URLSearchParams({
          lowerExtensionIntervals: String(rangeSelection.lowerExtensionIntervals),
          upperExtensionIntervals: String(rangeSelection.upperExtensionIntervals)
        });
        const response = await fetch(`/api/rebalance?${params.toString()}`, {
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
  }, [rangeSelection]);

  function updateRangeSelection(nextSelection: RangeSelection) {
    const normalized = {
      lowerExtensionIntervals: clampRangeExtension(nextSelection.lowerExtensionIntervals),
      upperExtensionIntervals: clampRangeExtension(nextSelection.upperExtensionIntervals)
    };
    setRangeSelection(normalized);
    window.localStorage.setItem(RANGE_WIDTH_STORAGE_KEY, rangeSelectionStorageValue(normalized));
  }

  function adjustRangeBoundary(boundary: "min" | "max", delta: number) {
    updateRangeSelection({
      lowerExtensionIntervals: rangeSelection.lowerExtensionIntervals + (boundary === "min" ? delta : 0),
      upperExtensionIntervals: rangeSelection.upperExtensionIntervals + (boundary === "max" ? delta : 0)
    });
  }

  async function copySwapAmount() {
    if (!data || data.swap.direction === "unavailable" || data.swap.direction === "none") return;
    const amount = formatPlainAmount(data.swap.spendAmount, data.swap.spendSymbol === "USDC" ? 2 : 6);
    const copied = await writeClipboardText(amount);
    setCopyState(copied ? "copied" : "failed");
    window.setTimeout(() => setCopyState("idle"), 1200);
  }

  async function copyPrice(boundary: "min" | "max") {
    const price = boundary === "min" ? data?.pool.lowerPrice : data?.pool.upperPrice;
    if (price === null || price === undefined || !Number.isFinite(price)) return;
    const copied = await writeClipboardText(formatPlainAmount(price, 4));
    setPriceCopyState(copied ? boundary : "failed");
    window.setTimeout(() => setPriceCopyState("idle"), 1200);
  }

  const swapClass = useMemo(() => {
    if (error && !data) return "bad";
    if (!data) return "";
    if (data.swap.direction === "unavailable") return "bad";
    if (data.swap.direction === "none") return "good";
    return "warn";
  }, [data, error]);

  const scaleSegments = rangeScaleSegments(rangeSelection);

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
        <div className="range-width-metric">
          <p className="metric-label">Width</p>
          <div className="range-scale-control">
            <div className="range-boundary-controls" role="group" aria-label="Minimum price controls">
              <button
                type="button"
                disabled={rangeSelection.lowerExtensionIntervals >= MAX_RANGE_EXTENSION_INTERVALS}
                title="Lower min price"
                aria-label="Lower min price"
                onClick={() => adjustRangeBoundary("min", 1)}
              >
                -
              </button>
              <button
                type="button"
                disabled={rangeSelection.lowerExtensionIntervals <= 0}
                title="Raise min price"
                aria-label="Raise min price"
                onClick={() => adjustRangeBoundary("min", -1)}
              >
                +
              </button>
            </div>
            <div className="range-scale" aria-label="Selected price range">
              {scaleSegments.map((segment) => (
                <span className={`${segment.active ? "is-active" : ""} ${segment.tone}`} key={segment.key} />
              ))}
              <span className="range-scale-current">{formatPlainAmount(data?.pool.price, 2)}</span>
            </div>
            <div className="range-boundary-controls" role="group" aria-label="Maximum price controls">
              <button
                type="button"
                disabled={rangeSelection.upperExtensionIntervals <= 0}
                title="Lower max price"
                aria-label="Lower max price"
                onClick={() => adjustRangeBoundary("max", -1)}
              >
                -
              </button>
              <button
                type="button"
                disabled={rangeSelection.upperExtensionIntervals >= MAX_RANGE_EXTENSION_INTERVALS}
                title="Raise max price"
                aria-label="Raise max price"
                onClick={() => adjustRangeBoundary("max", 1)}
              >
                +
              </button>
            </div>
          </div>
          <span>{formatPercent(data?.pool.widthPercent)} width</span>
        </div>
        <div className="range-metric">
          <p className="metric-label">Range</p>
          <div className="range-prices">
            <div>
              <span>Min price</span>
              <button
                type="button"
                className="copy-price"
                disabled={!data}
                title={priceCopyState === "min" ? "Copied" : "Copy min price"}
                aria-label={priceCopyState === "min" ? "Copied min price" : "Copy min price"}
                onClick={() => copyPrice("min")}
              >
                <strong>{formatPlainAmount(data?.pool.lowerPrice, 4)}</strong>
              </button>
              <small>{formatSignedPercent(priceOffsetPercent(data?.pool.price, data?.pool.lowerPrice))}</small>
            </div>
            <div>
              <span>Current price</span>
              <strong>{formatPlainAmount(data?.pool.price, 4)}</strong>
              <small>0%</small>
            </div>
            <div>
              <span>Max price</span>
              <button
                type="button"
                className="copy-price"
                disabled={!data}
                title={priceCopyState === "max" ? "Copied" : "Copy max price"}
                aria-label={priceCopyState === "max" ? "Copied max price" : "Copy max price"}
                onClick={() => copyPrice("max")}
              >
                <strong>{formatPlainAmount(data?.pool.upperPrice, 4)}</strong>
              </button>
              <small>{formatSignedPercent(priceOffsetPercent(data?.pool.price, data?.pool.upperPrice))}</small>
            </div>
          </div>
          <span className={`price-copy-feedback ${priceCopyState}`} aria-live="polite">
            {priceCopyState === "failed" ? "Copy failed" : priceCopyState === "idle" ? "" : "Copied"}
          </span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Wallet</p>
          <span className="metric-value">{formatAmount(data?.wallet.weth, 6)} WETH</span>
          <span>{formatAmount(data?.wallet.usdc, 2)} USDC</span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Target after swap</p>
          <span className="metric-value">{formatAmount(data?.target.weth, 6)} WETH</span>
          <span>{formatAmount(data?.target.usdc, 2)} USDC</span>
        </div>
      </div>

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
