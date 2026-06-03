"use client";

import { useEffect, useMemo, useState } from "react";
import { formatNumber } from "@/lib/format";
import type { HistoricalPricesByBlock } from "@/lib/historical-prices";
import { cashFlowNeutralGrowthSeries } from "@/lib/performance";
import type { TransactionTableRow } from "./transactions-table";

type GrowthChartProps = {
  rows: TransactionTableRow[];
  initialPrices: HistoricalPricesByBlock;
};

const CHART_WIDTH = 900;
const CHART_HEIGHT = 330;
const PADDING = { top: 24, right: 132, bottom: 34, left: 88 };

function formatPercent(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, 2)}%`;
}

function formatPercentagePoints(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : "";
  return `${sign}${formatNumber(value, 2)} pp`;
}

function formatUsd(value: number | null) {
  if (value === null || !Number.isFinite(value)) return "-";
  return `$${formatNumber(value, 2)}`;
}

function chunk<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

function linePath(points: Array<{ x: number; y: number }>) {
  return points.map((point, index) => `${index === 0 ? "M" : "L"} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(" ");
}

function latestFinite(values: Array<number | null>) {
  for (let index = values.length - 1; index >= 0; index -= 1) {
    const value = values[index];
    if (value !== null && Number.isFinite(value)) return value;
  }
  return null;
}

function latestFinitePoint(
  points: ReturnType<typeof cashFlowNeutralGrowthSeries>,
  key: "portfolioGrowthPercent" | "wethGrowthPercent"
) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const value = points[index][key];
    if (value !== null && Number.isFinite(value)) return { index, point: points[index], value };
  }
  return null;
}

export function GrowthChart({ rows, initialPrices }: GrowthChartProps) {
  const [prices, setPrices] = useState(initialPrices);
  const blockNumbers = useMemo(() => [...new Set(rows.map((row) => row.blockNumber))], [rows]);

  useEffect(() => {
    const missingBlockNumbers = blockNumbers.filter((blockNumber) => {
      const blockPrices = prices[blockNumber];
      return blockPrices?.ethPriceUsd === undefined || blockPrices?.aeroPriceUsd === undefined;
    });
    if (missingBlockNumbers.length === 0) return;

    const controller = new AbortController();
    void Promise.all(
      chunk(missingBlockNumbers, 100).map((blockNumberChunk) =>
        fetch("/api/prices/historical", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ blockNumbers: blockNumberChunk }),
          signal: controller.signal
        }).then((response) => (response.ok ? response.json() : Promise.reject(new Error("Failed to load historical prices"))))
      )
    )
      .then((payloads: Array<{ prices: HistoricalPricesByBlock }>) => {
        setPrices((current) => Object.assign({}, current, ...payloads.map((payload) => payload.prices)));
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
      });

    return () => controller.abort();
  }, [blockNumbers, prices]);

  const points = useMemo(() => cashFlowNeutralGrowthSeries(rows, prices), [rows, prices]);
  const chartPoints = points.filter((point) => point.portfolioGrowthPercent !== null || point.wethGrowthPercent !== null);
  const portfolioValues = chartPoints.map((point) => point.portfolioGrowthPercent);
  const wethValues = chartPoints.map((point) => point.wethGrowthPercent);
  const allValues = [...portfolioValues, ...wethValues].filter((value): value is number => value !== null && Number.isFinite(value));
  const latestPoint = chartPoints.at(-1);
  const latestPortfolioGrowth = latestFinite(portfolioValues);
  const latestWethGrowth = latestFinite(wethValues);
  const portfolioComparison =
    latestPortfolioGrowth === null || latestWethGrowth === null ? null : latestPortfolioGrowth - latestWethGrowth;
  const latestPortfolioPoint = latestFinitePoint(chartPoints, "portfolioGrowthPercent");
  const latestWethPoint = latestFinitePoint(chartPoints, "wethGrowthPercent");
  const cashFlowCount = points.filter((point) => point.isCashFlow).length;
  const minValue = Math.min(0, ...allValues);
  const maxValue = Math.max(0, ...allValues);
  const valueSpan = maxValue === minValue ? 1 : maxValue - minValue;
  const xSpan = Math.max(chartPoints.length - 1, 1);
  const plotWidth = CHART_WIDTH - PADDING.left - PADDING.right;
  const plotHeight = CHART_HEIGHT - PADDING.top - PADDING.bottom;
  const scaleX = (index: number) => PADDING.left + (index / xSpan) * plotWidth;
  const scaleY = (value: number) => PADDING.top + ((maxValue - value) / valueSpan) * plotHeight;
  const portfolioPath = linePath(
    chartPoints
      .map((point, index) => (point.portfolioGrowthPercent === null ? null : { x: scaleX(index), y: scaleY(point.portfolioGrowthPercent) }))
      .filter((point): point is { x: number; y: number } => point !== null)
  );
  const wethPath = linePath(
    chartPoints
      .map((point, index) => (point.wethGrowthPercent === null ? null : { x: scaleX(index), y: scaleY(point.wethGrowthPercent) }))
      .filter((point): point is { x: number; y: number } => point !== null)
  );
  const yTicks = [maxValue, minValue + valueSpan / 2, minValue];
  const firstDate = chartPoints[0] ? new Date(chartPoints[0].timestamp) : null;
  const lastDate = latestPoint ? new Date(latestPoint.timestamp) : null;
  const dateRangeLabel =
    firstDate && lastDate ? `${firstDate.toLocaleDateString()} - ${lastDate.toLocaleDateString()}` : "No priced range yet";
  const chartDescription = `Portfolio growth ${formatPercent(latestPortfolioGrowth)}, WETH growth ${formatPercent(
    latestWethGrowth
  )}, over ${dateRangeLabel}.`;

  return (
    <div className="growth-layout">
      <div className="growth-metrics">
        <div className="hero-metric">
          <p className="metric-label">Portfolio growth</p>
          <strong className={latestPortfolioGrowth !== null && latestPortfolioGrowth < 0 ? "negative-text" : ""}>
            {formatPercent(latestPortfolioGrowth)}
          </strong>
          <span>
            {portfolioComparison === null ? "cash-flow neutral" : `${formatPercentagePoints(portfolioComparison)} vs WETH`}
          </span>
        </div>
        <div className="hero-metric">
          <p className="metric-label">WETH growth</p>
          <strong className={latestWethGrowth !== null && latestWethGrowth < 0 ? "negative-text" : ""}>
            {formatPercent(latestWethGrowth)}
          </strong>
          <span>same start block</span>
        </div>
        <div className="hero-metric">
          <p className="metric-label">Current portfolio</p>
          <strong>{formatUsd(latestPoint?.portfolioTotalUsd ?? null)}</strong>
          <span>{cashFlowCount} deposits/withdrawals neutralized</span>
        </div>
      </div>

      <div className="chart-frame">
        {chartPoints.length < 2 || allValues.length === 0 ? (
          <div className="chart-empty">Need at least two priced transactions to draw growth.</div>
        ) : (
          <svg
            aria-labelledby="growth-chart-title growth-chart-description"
            className="growth-chart"
            role="img"
            viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
          >
            <title id="growth-chart-title">Cash-flow neutral portfolio growth compared with WETH growth</title>
            <desc id="growth-chart-description">{chartDescription}</desc>
            {yTicks.map((tick) => (
              <g key={tick.toFixed(4)}>
                <line
                  className="chart-grid"
                  x1={PADDING.left}
                  x2={CHART_WIDTH - PADDING.right}
                  y1={scaleY(tick)}
                  y2={scaleY(tick)}
                />
                <text className="chart-axis-label" x={PADDING.left - 10} y={scaleY(tick) + 4} textAnchor="end">
                  {formatPercent(tick)}
                </text>
              </g>
            ))}
            <line
              className="chart-zero"
              x1={PADDING.left}
              x2={CHART_WIDTH - PADDING.right}
              y1={scaleY(0)}
              y2={scaleY(0)}
            />
            <path className="chart-line portfolio-line" d={portfolioPath} />
            <path className="chart-line weth-line" d={wethPath} />
            {latestPortfolioPoint ? (
              <text
                className="chart-end-label portfolio-label"
                x={scaleX(latestPortfolioPoint.index) + 12}
                y={scaleY(latestPortfolioPoint.value) + 4}
              >
                Portfolio {formatPercent(latestPortfolioPoint.value)}
              </text>
            ) : null}
            {latestWethPoint ? (
              <text
                className="chart-end-label weth-label"
                x={scaleX(latestWethPoint.index) + 12}
                y={scaleY(latestWethPoint.value) + 4}
              >
                WETH {formatPercent(latestWethPoint.value)}
              </text>
            ) : null}
            {chartPoints.map((point, index) =>
              point.isCashFlow && point.portfolioGrowthPercent !== null ? (
                <circle
                  className="cash-flow-marker"
                  cx={scaleX(index)}
                  cy={scaleY(point.portfolioGrowthPercent)}
                  key={point.id}
                  r="4"
                />
              ) : null
            )}
            {chartPoints.map((point, index) => (
              <g className="chart-hit-point" key={`${point.id}-hit`} tabIndex={0}>
                <title>
                  {new Date(point.timestamp).toLocaleDateString()} - Portfolio {formatPercent(point.portfolioGrowthPercent)},
                  WETH {formatPercent(point.wethGrowthPercent)}, value {formatUsd(point.portfolioTotalUsd)}
                </title>
                {point.portfolioGrowthPercent !== null ? (
                  <circle cx={scaleX(index)} cy={scaleY(point.portfolioGrowthPercent)} r="9" />
                ) : null}
                {point.wethGrowthPercent !== null ? <circle cx={scaleX(index)} cy={scaleY(point.wethGrowthPercent)} r="9" /> : null}
              </g>
            ))}
            <text className="chart-date-label" x={PADDING.left} y={CHART_HEIGHT - 10}>
              {firstDate?.toLocaleDateString() ?? ""}
            </text>
            <text className="chart-date-label" x={CHART_WIDTH - PADDING.right} y={CHART_HEIGHT - 10} textAnchor="end">
              {lastDate?.toLocaleDateString() ?? ""}
            </text>
          </svg>
        )}
      </div>

      <div className="chart-summary" aria-hidden="true">
        <span>{dateRangeLabel}</span>
        <span>{chartPoints.length} priced points</span>
        {portfolioComparison !== null ? <span>{formatPercentagePoints(portfolioComparison)} vs WETH</span> : null}
      </div>

      <div className="chart-legend">
        <span>
          <i className="legend-swatch portfolio" /> Portfolio
        </span>
        <span>
          <i className="legend-swatch weth" /> WETH
        </span>
        {cashFlowCount > 0 ? (
          <span>
            <i className="legend-dot" /> Deposit/withdrawal reset point
          </span>
        ) : null}
      </div>
    </div>
  );
}
