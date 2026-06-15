import { describe, expect, it } from "vitest";
import {
  cashFlowNeutralGrowthSeries,
  portfolioTotalUsd,
  type PerformanceAssetAmounts,
  type PerformanceTransaction
} from "@/lib/performance";

function row(overrides: Omit<Partial<PerformanceTransaction>, "assets"> & { assets?: Partial<PerformanceAssetAmounts> }): PerformanceTransaction {
  return {
    id: overrides.id ?? "tx",
    blockNumber: overrides.blockNumber ?? "1",
    timestamp: overrides.timestamp ?? "2026-01-01T00:00:00.000Z",
    type: overrides.type ?? "swap",
    tokenAmounts: overrides.tokenAmounts ?? [],
    assets: {
      weth: null,
      usdc: overrides.assets?.usdc ?? 0,
      aero: null,
      eth: null,
      lpWeth: null,
      lpUsdc: null,
      ...overrides.assets
    }
  };
}

describe("portfolio performance", () => {
  it("uses implied AERO swap price when no cached AERO price is available", () => {
    const total = portfolioTotalUsd(
      row({
        tokenAmounts: [
          { symbol: "AERO", amount: "10", direction: "out" },
          { symbol: "USDC", amount: "25", direction: "in" }
        ],
        assets: { aero: 2, usdc: 5 }
      }),
      { ethPriceUsd: 3000 }
    );

    expect(total).toBe(10);
  });

  it("keeps portfolio growth flat across deposits and resumes from the new portfolio base", () => {
    const rows = [
      row({ id: "trade-2", blockNumber: "4", timestamp: "2026-01-04T00:00:00.000Z", assets: { usdc: 330 } }),
      row({ id: "deposit", blockNumber: "3", timestamp: "2026-01-03T00:00:00.000Z", type: "deposit", assets: { usdc: 300 } }),
      row({ id: "trade-1", blockNumber: "2", timestamp: "2026-01-02T00:00:00.000Z", assets: { usdc: 110 } }),
      row({ id: "start", blockNumber: "1", timestamp: "2026-01-01T00:00:00.000Z", assets: { usdc: 100 } })
    ];

    const points = cashFlowNeutralGrowthSeries(rows, {
      "1": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "2": { ethPriceUsd: 1200, aeroPriceUsd: 1 },
      "3": { ethPriceUsd: 1400, aeroPriceUsd: 1 },
      "4": { ethPriceUsd: 1500, aeroPriceUsd: 1 }
    });

    expect(points[0].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[1].portfolioGrowthPercent).toBeCloseTo(10);
    expect(points[2].portfolioGrowthPercent).toBeCloseTo(10);
    expect(points[3].portfolioGrowthPercent).toBeCloseTo(21);
    expect(points.at(-1)?.wethGrowthPercent).toBeCloseTo(50);
    expect((points.at(-1)?.portfolioGrowthPercent ?? 0) - (points.at(-1)?.wethGrowthPercent ?? 0)).toBeCloseTo(-29);
  });

  it("keeps normal LP lifecycle valuation changes in portfolio growth", () => {
    const rows = [
      row({ id: "after-rebalance", blockNumber: "3", timestamp: "2026-01-03T00:00:00.000Z", type: "swap", assets: { usdc: 110 } }),
      row({ id: "mint", blockNumber: "2", timestamp: "2026-01-02T00:00:00.000Z", type: "lp_deposit", assets: { usdc: 105 } }),
      row({ id: "start", blockNumber: "1", timestamp: "2026-01-01T00:00:00.000Z", assets: { usdc: 100 } })
    ];

    const points = cashFlowNeutralGrowthSeries(rows, {
      "1": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "2": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "3": { ethPriceUsd: 1000, aeroPriceUsd: 1 }
    });

    expect(points[1].portfolioGrowthPercent).toBeCloseTo(5);
    expect(points[2].portfolioGrowthPercent).toBeCloseTo(10);
  });

  it("ignores discontinuous LP lifecycle snapshots without flattening later growth", () => {
    const rows = [
      row({ id: "after-rebalance", blockNumber: "4", timestamp: "2026-01-04T00:00:00.000Z", type: "swap", assets: { usdc: 110 } }),
      row({ id: "mint", blockNumber: "3", timestamp: "2026-01-03T00:00:00.000Z", type: "lp_deposit", assets: { usdc: 100 } }),
      row({ id: "close", blockNumber: "2", timestamp: "2026-01-02T00:00:00.000Z", type: "lp_exit", assets: { usdc: 5 } }),
      row({ id: "start", blockNumber: "1", timestamp: "2026-01-01T00:00:00.000Z", assets: { usdc: 100 } })
    ];

    const points = cashFlowNeutralGrowthSeries(rows, {
      "1": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "2": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "3": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "4": { ethPriceUsd: 1000, aeroPriceUsd: 1 }
    });

    expect(points[1].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[2].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[3].portfolioGrowthPercent).toBeCloseTo(10);
  });

  it("ignores incomplete non-LP snapshots that temporarily miss active LP value", () => {
    const rows = [
      row({ id: "after", blockNumber: "4", timestamp: "2026-01-04T00:00:00.000Z", type: "swap", assets: { usdc: 110 } }),
      row({ id: "missing-lp", blockNumber: "3", timestamp: "2026-01-03T00:00:00.000Z", type: "swap", assets: { usdc: 10 } }),
      row({ id: "mint", blockNumber: "2", timestamp: "2026-01-02T00:00:00.000Z", type: "lp_deposit", assets: { usdc: 100 } }),
      row({ id: "start", blockNumber: "1", timestamp: "2026-01-01T00:00:00.000Z", assets: { usdc: 100 } })
    ];

    const points = cashFlowNeutralGrowthSeries(rows, {
      "1": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "2": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "3": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "4": { ethPriceUsd: 1000, aeroPriceUsd: 1 }
    });

    expect(points[2].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[2].portfolioTotalUsd).toBeNull();
    expect(points[3].portfolioGrowthPercent).toBeCloseTo(10);
  });

  it("does not compound a chain of incomplete snapshots into a fake drawdown", () => {
    const rows = [
      row({ id: "recovered", blockNumber: "6", timestamp: "2026-01-06T00:00:00.000Z", type: "swap", assets: { usdc: 108 } }),
      row({ id: "missing-3", blockNumber: "5", timestamp: "2026-01-05T00:00:00.000Z", type: "swap", assets: { usdc: 20 } }),
      row({ id: "missing-2", blockNumber: "4", timestamp: "2026-01-04T00:00:00.000Z", type: "swap", assets: { usdc: 45 } }),
      row({ id: "missing-1", blockNumber: "3", timestamp: "2026-01-03T00:00:00.000Z", type: "swap", assets: { usdc: 70 } }),
      row({ id: "mint", blockNumber: "2", timestamp: "2026-01-02T00:00:00.000Z", type: "lp_deposit", assets: { usdc: 100 } }),
      row({ id: "start", blockNumber: "1", timestamp: "2026-01-01T00:00:00.000Z", assets: { usdc: 100 } })
    ];

    const points = cashFlowNeutralGrowthSeries(rows, {
      "1": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "2": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "3": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "4": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "5": { ethPriceUsd: 1000, aeroPriceUsd: 1 },
      "6": { ethPriceUsd: 1000, aeroPriceUsd: 1 }
    });

    expect(points[2].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[2].portfolioTotalUsd).toBeNull();
    expect(points[3].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[3].portfolioTotalUsd).toBeNull();
    expect(points[4].portfolioGrowthPercent).toBeCloseTo(0);
    expect(points[4].portfolioTotalUsd).toBeNull();
    expect(points[5].portfolioGrowthPercent).toBeCloseTo(8);
  });
});
