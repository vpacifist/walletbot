import { describe, expect, it } from "vitest";
import { rebalanceImpermanentLossUsd, rebalanceSwapSummary } from "@/lib/rebalance-metrics";

describe("rebalance metrics", () => {
  it("uses matched WETH volume and adverse price difference for sell-to-buy reversals", () => {
    expect(
      rebalanceImpermanentLossUsd(
        { side: "buy_weth", wethAmount: 0.9, effectivePrice: 1_100 },
        { side: "sell_weth", wethAmount: 1, effectivePrice: 1_000 }
      )
    ).toBeCloseTo(90);
  });

  it("uses matched WETH volume and adverse price difference for buy-to-sell reversals", () => {
    expect(
      rebalanceImpermanentLossUsd(
        { side: "sell_weth", wethAmount: 0.8, effectivePrice: 950 },
        { side: "buy_weth", wethAmount: 1.2, effectivePrice: 1_000 }
      )
    ).toBeCloseTo(40);
  });

  it("does not report negative IL when the reversal price is favorable", () => {
    expect(
      rebalanceImpermanentLossUsd(
        { side: "buy_weth", wethAmount: 0.9, effectivePrice: 950 },
        { side: "sell_weth", wethAmount: 1, effectivePrice: 1_000 }
      )
    ).toBe(0);
  });

  it("does not report IL when the previous rebalance direction matches", () => {
    expect(
      rebalanceImpermanentLossUsd(
        { side: "sell_weth", wethAmount: 0.3, effectivePrice: 2_027.67 },
        { side: "sell_weth", wethAmount: 0.4, effectivePrice: 2_100 }
      )
    ).toBeNull();
  });

  it("normalizes swap notional from the USDC leg", () => {
    expect(
      rebalanceSwapSummary({
        side: "buy_weth",
        wethAmount: 0.25,
        usdcAmount: 500,
        effectivePrice: 2_000
      })
    ).toEqual({
      side: "buy_weth",
      wethAmount: 0.25,
      usdcAmount: 500,
      effectivePrice: 2_000,
      notionalUsd: 500
    });
  });
});
