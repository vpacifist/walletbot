"use client";

import { useEffect, useMemo, useState } from "react";

type TripleRangeData = {
  pool: {
    currentTick: number;
    baseTick: number;
    price: number;
  };
  totals: {
    walletWeth: number | null;
    walletUsdc: number | null;
    walletValueUsd: number;
    positionsValueUsd: number;
    portfolioValueUsd: number;
    targetPerRangeUsd: number;
  };
  segments: Array<{
    role: "lower" | "active" | "upper";
    label: string;
    expected: "USDC" | "WETH + USDC" | "WETH";
    lowerTick: number;
    upperTick: number;
    lowerPrice: number | null;
    upperPrice: number | null;
    targetUsd: number;
    position: {
      tokenId: string;
      status: string;
      weth: number;
      usdc: number;
      valueUsd: number;
      sharePercent: number;
      driftPercent: number;
    } | null;
    state: "ok" | "warn" | "missing";
    note: string;
  }>;
  leftovers: Array<{
    tokenId: string;
    tickLower: number;
    tickUpper: number;
    status: string;
    weth: number;
    usdc: number;
    valueUsd: number;
    suggestedUse: string;
  }>;
  recommendation: {
    severity: "good" | "warn" | "bad";
    title: string;
    detail: string;
    actions: string[];
  };
  updatedAt: string;
};

function formatAmount(value: number | null | undefined, digits: number) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function formatUsd(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  return `$${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}`;
}

function formatPercent(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, { maximumFractionDigits: 1 })}%`;
}

function statusClass(state: "ok" | "warn" | "missing") {
  if (state === "ok") return "good";
  if (state === "missing") return "bad";
  return "warn";
}

function segmentPositionLabel(segment: TripleRangeData["segments"][number]) {
  if (!segment.position) return "No position";
  return `#${segment.position.tokenId}`;
}

function shortError(message: string) {
  if (message.includes("429") || message.toLowerCase().includes("too many requests")) {
    return "RPC rate limit. Showing the guide again when cached or synced pool data is available.";
  }
  if (message.length <= 180) return message;
  return `${message.slice(0, 177)}...`;
}

function rangeSide(segment: TripleRangeData["segments"][number], currentTick: number | undefined) {
  if (currentTick === undefined) return "unknown";
  if (currentTick < segment.lowerTick) return "above price";
  if (currentTick >= segment.upperTick) return "below price";
  return "contains price";
}

function isCorrectSide(segment: TripleRangeData["segments"][number], currentTick: number | undefined) {
  const side = rangeSide(segment, currentTick);
  if (segment.role === "lower") return side === "below price";
  if (segment.role === "active") return side === "contains price";
  return side === "above price";
}

function markerBottomPercent(data: TripleRangeData | null) {
  if (!data || data.segments.length === 0) return 50;
  const lowerTick = Math.min(...data.segments.map((segment) => segment.lowerTick));
  const upperTick = Math.max(...data.segments.map((segment) => segment.upperTick));
  if (upperTick <= lowerTick) return 50;
  return Math.max(0, Math.min(100, ((data.pool.currentTick - lowerTick) / (upperTick - lowerTick)) * 100));
}

export function TripleRangeGuideLive() {
  const [data, setData] = useState<TripleRangeData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      const controller = new AbortController();
      const abortId = window.setTimeout(() => controller.abort(), 20_000);

      try {
        const response = await fetch("/api/triple-range-guide", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal
        });
        const payload = (await response.json()) as TripleRangeData | { error?: string };
        if (!active) return;

        if (!response.ok) {
          setError("error" in payload && payload.error ? payload.error : "Unable to load triple range guide");
          return;
        }

        setData(payload as TripleRangeData);
        setError(null);
      } catch (requestError) {
        if (active) {
          setError(
            requestError instanceof DOMException && requestError.name === "AbortError"
              ? "Triple range request timed out"
              : "Unable to load triple range guide"
          );
        }
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
  }, []);

  const recommendationClass = useMemo(() => {
    if (error && !data) return "bad";
    return data?.recommendation.severity ?? "";
  }, [data, error]);
  const ladderSegments = useMemo(() => {
    return data ? [...data.segments].sort((left, right) => right.lowerTick - left.lowerTick) : [];
  }, [data]);
  const priceMarkerBottom = markerBottomPercent(data);

  return (
    <div className="triple-guide-grid">
      <div className="rebalance-primary">
        <div className={`hero-metric ${recommendationClass}`}>
          <p className="metric-label">Action</p>
          <strong>{error && !data ? "Triple range unavailable" : (data?.recommendation.title ?? "Loading")}</strong>
          <p className="muted">
            {error && !data ? shortError(error) : (data?.recommendation.detail ?? "Checking the three adjacent WETH/USDC ranges.")}
          </p>
        </div>
        <div className="hero-metric">
          <p className="metric-label">Target per range</p>
          <strong>{formatUsd(data?.totals.targetPerRangeUsd)}</strong>
          <p className="muted">
            {formatUsd(data?.totals.portfolioValueUsd)} total · {formatUsd(data?.totals.positionsValueUsd)} in LP
          </p>
        </div>
      </div>

      <div className="triple-ladder" aria-label="Current price across triple range ladder">
        <div className="triple-ladder-axis">
          {data ? (
            <>
              {ladderSegments.map((segment) => {
                const correctSide = isCorrectSide(segment, data.pool.currentTick);
                return (
                  <div className={`triple-ladder-segment ${segment.role}`} key={segment.role}>
                    <div className="triple-ladder-segment-label">
                      <strong>{segment.label}</strong>
                      <span>{segmentPositionLabel(segment)}</span>
                    </div>
                    <div className="triple-ladder-price-labels">
                      <span>{formatAmount(segment.upperPrice, 2)}</span>
                      <span>{formatAmount(segment.lowerPrice, 2)}</span>
                    </div>
                    <span className={`status ${correctSide ? "good" : "bad"}`}>{rangeSide(segment, data.pool.currentTick)}</span>
                  </div>
                );
              })}
              <div className="triple-ladder-marker" style={{ bottom: `${priceMarkerBottom}%` }}>
                <span>{formatAmount(data.pool.price, 2)} USDC</span>
                <small>tick {data.pool.currentTick}</small>
              </div>
            </>
          ) : (
            <div className="triple-ladder-loading" />
          )}
        </div>
      </div>

      <div className="triple-range-strip" aria-label="Triple range state">
        {data?.segments.map((segment) => (
          <div className={`triple-range-card ${segment.role}`} key={segment.role}>
            <div className="triple-range-card-head">
              <div>
                <p className="metric-label">{segment.label}</p>
                <strong>{segmentPositionLabel(segment)}</strong>
              </div>
              <span className={`status ${statusClass(segment.state)}`}>{segment.state}</span>
            </div>
            <div className="triple-range-band">
              <span style={{ width: `${Math.max(0, Math.min(100, segment.position?.sharePercent ?? 0))}%` }} />
            </div>
            <div className="triple-range-metrics">
              <span>{formatUsd(segment.position?.valueUsd)} now</span>
              <span>{formatPercent(segment.position?.driftPercent)} vs 33%</span>
              <span>{data ? rangeSide(segment, data.pool.currentTick) : "side unknown"}</span>
              <span>
                {formatAmount(segment.position?.weth, 6)} WETH · {formatAmount(segment.position?.usdc, 2)} USDC
              </span>
              <span>
                {formatAmount(segment.lowerPrice, 2)} - {formatAmount(segment.upperPrice, 2)}
              </span>
            </div>
            <p className="muted">{segment.expected} · {segment.note}</p>
          </div>
        )) ?? (
          <>
            <div className="triple-range-card skeleton" />
            <div className="triple-range-card skeleton" />
            <div className="triple-range-card skeleton" />
          </>
        )}
      </div>

      <div className="metric-list triple-guide-metrics">
        <div className="asset-metric">
          <p className="metric-label">Current price</p>
          <span className="metric-value">{formatAmount(data?.pool.price, 2)} USDC</span>
          <span>Tick {data?.pool.currentTick ?? "-"}</span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Wallet</p>
          <span className="metric-value">{formatAmount(data?.totals.walletWeth, 6)} WETH</span>
          <span>{formatAmount(data?.totals.walletUsdc, 2)} USDC</span>
        </div>
        <div className="asset-metric">
          <p className="metric-label">Next steps</p>
          <span className="metric-value">{data?.recommendation.actions.length ?? 0} action(s)</span>
          <span>{data?.leftovers.length ?? 0} extra range(s)</span>
        </div>
      </div>

      {data ? (
        <div className="triple-action-list">
          {data.recommendation.actions.map((action) => (
            <div className="triple-action" key={action}>
              {action}
            </div>
          ))}
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}
    </div>
  );
}
