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

  it("does not treat LP lifecycle reshuffles as portfolio losses", () => {
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
});
