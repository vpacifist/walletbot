import type { HistoricalPricesByBlock } from "@/lib/historical-prices";

const LP_SNAPSHOT_DISCONTINUITY_MIN_RATIO = 0.5;
const LP_SNAPSHOT_DISCONTINUITY_MAX_RATIO = 1.5;

export type PerformanceAssetAmounts = {
  weth: number | null;
  usdc: number | null;
  aero: number | null;
  eth: number | null;
  lpWeth: number | null;
  lpUsdc: number | null;
};

export type PerformanceTransaction = {
  id: string;
  blockNumber: string;
  timestamp: string;
  type: string;
  tokenAmounts: unknown;
  assets: PerformanceAssetAmounts;
};

export type GrowthChartPoint = {
  id: string;
  timestamp: string;
  type: string;
  portfolioGrowthPercent: number | null;
  wethGrowthPercent: number | null;
  portfolioTotalUsd: number | null;
  wethPriceUsd: number | null;
  isCashFlow: boolean;
};

function valueUsd(amount: number | null, priceUsd?: number | null) {
  if (amount === null) return null;
  if (priceUsd === undefined) return undefined;
  if (priceUsd === null) return null;
  return amount * priceUsd;
}

export function impliedAeroPriceUsd(type: string, value: unknown) {
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

export function portfolioTotalUsd(row: PerformanceTransaction, prices?: { ethPriceUsd?: number | null; aeroPriceUsd?: number | null }) {
  const aeroPriceUsd = impliedAeroPriceUsd(row.type, row.tokenAmounts) ?? prices?.aeroPriceUsd;
  const values = [
    valueUsd(row.assets.weth, prices?.ethPriceUsd),
    row.assets.usdc,
    valueUsd(row.assets.aero, aeroPriceUsd),
    valueUsd(row.assets.eth, prices?.ethPriceUsd),
    valueUsd(row.assets.lpWeth, prices?.ethPriceUsd),
    row.assets.lpUsdc
  ];

  if (values.some((value) => value === undefined)) return undefined;
  if (values.every((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

export function cashFlowNeutralGrowthSeries(rows: PerformanceTransaction[], prices: HistoricalPricesByBlock): GrowthChartPoint[] {
  const chronologicalRows = [...rows].reverse();
  let baseWethPrice: number | null = null;
  let previousPortfolioTotal: number | null = null;
  let portfolioIndex = 1;

  return chronologicalRows.map((row) => {
    const rowPrices = prices[row.blockNumber] ?? {};
    const wethPriceUsd = rowPrices.ethPriceUsd ?? null;
    const totalUsd = portfolioTotalUsd(row, rowPrices);
    const portfolioTotal = totalUsd === undefined ? null : totalUsd;
    const isCashFlow = row.type === "deposit" || row.type === "withdrawal";
    const isLpLifecycle = row.type.startsWith("lp_");

    if (baseWethPrice === null && wethPriceUsd !== null && wethPriceUsd > 0) {
      baseWethPrice = wethPriceUsd;
    }

    if (portfolioTotal !== null && portfolioTotal > 0) {
      if (previousPortfolioTotal === null || previousPortfolioTotal <= 0) {
        previousPortfolioTotal = portfolioTotal;
      } else if (isCashFlow) {
        previousPortfolioTotal = portfolioTotal;
      } else {
        const ratio = portfolioTotal / previousPortfolioTotal;
        const isLpSnapshotDiscontinuity =
          isLpLifecycle && (ratio < LP_SNAPSHOT_DISCONTINUITY_MIN_RATIO || ratio > LP_SNAPSHOT_DISCONTINUITY_MAX_RATIO);

        if (!isLpSnapshotDiscontinuity) {
          portfolioIndex *= ratio;
          previousPortfolioTotal = portfolioTotal;
        }
      }
    }

    return {
      id: row.id,
      timestamp: row.timestamp,
      type: row.type,
      portfolioGrowthPercent: previousPortfolioTotal === null ? null : (portfolioIndex - 1) * 100,
      wethGrowthPercent: baseWethPrice === null || wethPriceUsd === null ? null : (wethPriceUsd / baseWethPrice - 1) * 100,
      portfolioTotalUsd: portfolioTotal,
      wethPriceUsd,
      isCashFlow
    };
  });
}
