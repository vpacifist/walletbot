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
const DATE_FORMATTER = new Intl.DateTimeFormat("de-DE");
const TOOLTIP_WIDTH = 178;
const TOOLTIP_HEIGHT = 104;

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

function annualizedPercent(totalReturnPercent: number | null, startDate: Date | null, endDate: Date | null) {
  if (totalReturnPercent === null || !Number.isFinite(totalReturnPercent) || !startDate || !endDate) return null;
  const elapsedYears = (endDate.getTime() - startDate.getTime()) / (365 * 24 * 60 * 60 * 1000);
  if (elapsedYears <= 0) return null;
  return totalReturnPercent / elapsedYears;
}

function formatDate(value: Date | string | null) {
  if (!value) return "";
  return DATE_FORMATTER.format(new Date(value));
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
  key: "portfolioGrowthPercent" | "wethGrowthPercent" | "portfolioVsWethPercentagePoints"
) {
  for (let index = points.length - 1; index >= 0; index -= 1) {
    const point = points[index];
    const value =
      key === "portfolioVsWethPercentagePoints"
        ? portfolioVsWethPercentagePoints(point.portfolioGrowthPercent, point.wethGrowthPercent)
        : point[key];
    if (value !== null && Number.isFinite(value)) return { index, point: points[index], value };
  }
  return null;
}

function portfolioVsWethPercentagePoints(portfolioGrowthPercent: number | null, wethGrowthPercent: number | null) {
  if (portfolioGrowthPercent === null || wethGrowthPercent === null) return null;
  if (!Number.isFinite(portfolioGrowthPercent) || !Number.isFinite(wethGrowthPercent)) return null;
  return portfolioGrowthPercent - wethGrowthPercent;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function GrowthChart({ rows, initialPrices }: GrowthChartProps) {
  const [prices, setPrices] = useState(initialPrices);
  const [activePointIndex, setActivePointIndex] = useState<number | null>(null);
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
  const comparisonValues = chartPoints.map((point) =>
    portfolioVsWethPercentagePoints(point.portfolioGrowthPercent, point.wethGrowthPercent)
  );
  const allValues = [...portfolioValues, ...wethValues, ...comparisonValues].filter(
    (value): value is number => value !== null && Number.isFinite(value)
  );
  const latestPoint = chartPoints.at(-1);
  const latestPortfolioGrowth = latestFinite(portfolioValues);
  const latestWethGrowth = latestFinite(wethValues);
  const latestComparison = latestFinite(comparisonValues);
  const portfolioComparison =
    latestPortfolioGrowth === null || latestWethGrowth === null ? null : latestPortfolioGrowth - latestWethGrowth;
  const latestPortfolioPoint = latestFinitePoint(chartPoints, "portfolioGrowthPercent");
  const latestWethPoint = latestFinitePoint(chartPoints, "wethGrowthPercent");
  const latestComparisonPoint = latestFinitePoint(chartPoints, "portfolioVsWethPercentagePoints");
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
  const comparisonPath = linePath(
    chartPoints
      .map((point, index) => {
        const value = portfolioVsWethPercentagePoints(point.portfolioGrowthPercent, point.wethGrowthPercent);
        return value === null ? null : { x: scaleX(index), y: scaleY(value) };
      })
      .filter((point): point is { x: number; y: number } => point !== null)
  );
  const yTicks = [maxValue, minValue + valueSpan / 2, minValue];
  const dateTickCount = Math.min(5, chartPoints.length);
  const dateTickIndexes = Array.from(
    new Set(
      Array.from({ length: dateTickCount }, (_, index) =>
        Math.round((index / Math.max(dateTickCount - 1, 1)) * (chartPoints.length - 1))
      )
    )
  );
  const firstDate = chartPoints[0] ? new Date(chartPoints[0].timestamp) : null;
  const lastDate = latestPoint ? new Date(latestPoint.timestamp) : null;
  const latestAprSinceStart = annualizedPercent(latestPortfolioGrowth, firstDate, lastDate);
  const activePoint = activePointIndex === null ? null : chartPoints[activePointIndex] ?? null;
  const activeComparison = activePoint
    ? portfolioVsWethPercentagePoints(activePoint.portfolioGrowthPercent, activePoint.wethGrowthPercent)
    : null;
  const activeX = activePointIndex === null ? null : scaleX(activePointIndex);
  const activeTooltipX =
    activeX === null ? 0 : clamp(activeX + 12, PADDING.left, CHART_WIDTH - PADDING.right - TOOLTIP_WIDTH);
  const activeTooltipY =
    activePoint && activeComparison !== null
      ? clamp(scaleY(activeComparison) - TOOLTIP_HEIGHT - 10, PADDING.top, CHART_HEIGHT - PADDING.bottom - TOOLTIP_HEIGHT)
      : PADDING.top;
  const dateRangeLabel = firstDate && lastDate ? `${formatDate(firstDate)} - ${formatDate(lastDate)}` : "No priced range yet";
  const chartDescription = `Portfolio growth ${formatPercent(latestPortfolioGrowth)}, WETH growth ${formatPercent(
    latestWethGrowth
  )}, portfolio minus WETH ${formatPercentagePoints(latestComparison)}, over ${dateRangeLabel}.`;

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
        <div className="hero-metric">
          <p className="metric-label">Portfolio vs WETH</p>
          <strong className={latestComparison !== null && latestComparison < 0 ? "negative-text" : ""}>
            {formatPercentagePoints(latestComparison)}
          </strong>
          <span>percentage-point spread</span>
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
            <path className="chart-line comparison-line" d={comparisonPath} />
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
            {latestComparisonPoint ? (
              <text
                className="chart-end-label comparison-label"
                x={scaleX(latestComparisonPoint.index) + 12}
                y={scaleY(latestComparisonPoint.value) + 4}
              >
                vs WETH {formatPercentagePoints(latestComparisonPoint.value)}
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
              <g
                className="chart-hit-point"
                key={`${point.id}-hit`}
                onBlur={() => setActivePointIndex(null)}
                onFocus={() => setActivePointIndex(index)}
                onMouseEnter={() => setActivePointIndex(index)}
                onMouseLeave={() => setActivePointIndex(null)}
                tabIndex={0}
              >
                <rect
                  className="chart-hit-zone"
                  height={plotHeight}
                  width={Math.max(plotWidth / Math.max(chartPoints.length - 1, 1), 14)}
                  x={scaleX(index) - Math.max(plotWidth / Math.max(chartPoints.length - 1, 1), 14) / 2}
                  y={PADDING.top}
                />
                <title>
                  {formatDate(point.timestamp)} - Portfolio {formatPercent(point.portfolioGrowthPercent)},
                  WETH {formatPercent(point.wethGrowthPercent)}, vs WETH{" "}
                  {formatPercentagePoints(portfolioVsWethPercentagePoints(point.portfolioGrowthPercent, point.wethGrowthPercent))}, value{" "}
                  {formatUsd(point.portfolioTotalUsd)}
                </title>
                {point.portfolioGrowthPercent !== null ? (
                  <circle cx={scaleX(index)} cy={scaleY(point.portfolioGrowthPercent)} r="9" />
                ) : null}
                {point.wethGrowthPercent !== null ? <circle cx={scaleX(index)} cy={scaleY(point.wethGrowthPercent)} r="9" /> : null}
                {portfolioVsWethPercentagePoints(point.portfolioGrowthPercent, point.wethGrowthPercent) !== null ? (
                  <circle
                    cx={scaleX(index)}
                    cy={scaleY(portfolioVsWethPercentagePoints(point.portfolioGrowthPercent, point.wethGrowthPercent) ?? 0)}
                    r="9"
                  />
                ) : null}
              </g>
            ))}
            {activePoint && activePointIndex !== null && activeX !== null ? (
              <g className="chart-active-point" pointerEvents="none">
                <line className="chart-hover-line" x1={activeX} x2={activeX} y1={PADDING.top} y2={CHART_HEIGHT - PADDING.bottom} />
                {activePoint.portfolioGrowthPercent !== null ? (
                  <circle className="portfolio-marker" cx={activeX} cy={scaleY(activePoint.portfolioGrowthPercent)} r="4" />
                ) : null}
                {activePoint.wethGrowthPercent !== null ? (
                  <circle className="weth-marker" cx={activeX} cy={scaleY(activePoint.wethGrowthPercent)} r="4" />
                ) : null}
                {activeComparison !== null ? (
                  <circle className="comparison-marker" cx={activeX} cy={scaleY(activeComparison)} r="4" />
                ) : null}
                <g transform={`translate(${activeTooltipX} ${activeTooltipY})`}>
                  <rect className="chart-tooltip-box" width={TOOLTIP_WIDTH} height={TOOLTIP_HEIGHT} rx="6" />
                  <text className="chart-tooltip-title" x="10" y="18">
                    {formatDate(activePoint.timestamp)}
                  </text>
                  <text className="chart-tooltip-row portfolio-label" x="10" y="40">
                    Portfolio {formatPercent(activePoint.portfolioGrowthPercent)}
                  </text>
                  <text className="chart-tooltip-row weth-label" x="10" y="58">
                    WETH {formatPercent(activePoint.wethGrowthPercent)}
                  </text>
                  <text className="chart-tooltip-row comparison-label" x="10" y="76">
                    vs WETH {formatPercentagePoints(activeComparison)}
                  </text>
                  <text className="chart-tooltip-row" x="10" y="94">
                    Value {formatUsd(activePoint.portfolioTotalUsd)}
                  </text>
                </g>
              </g>
            ) : null}
            {dateTickIndexes.map((index) => (
              <text
                className="chart-date-label"
                key={`date-${chartPoints[index].id}`}
                x={scaleX(index)}
                y={CHART_HEIGHT - 10}
                textAnchor={index === 0 ? "start" : index === chartPoints.length - 1 ? "end" : "middle"}
              >
                {formatDate(chartPoints[index].timestamp)}
              </text>
            ))}
          </svg>
        )}
      </div>

      <div className="chart-summary" aria-hidden="true">
        <span>{dateRangeLabel}</span>
        <span>{chartPoints.length} priced points</span>
        {portfolioComparison !== null ? <span>{formatPercentagePoints(portfolioComparison)} vs WETH</span> : null}
        {latestPortfolioGrowth !== null && latestAprSinceStart !== null ? (
          <span>
            now {formatPercent(latestPortfolioGrowth)}; annualized {formatPercent(latestAprSinceStart)}
          </span>
        ) : null}
      </div>

      <div className="chart-legend">
        <span>
          <i className="legend-swatch portfolio" /> Portfolio
        </span>
        <span>
          <i className="legend-swatch weth" /> WETH
        </span>
        <span>
          <i className="legend-swatch comparison" /> Portfolio vs WETH
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
