import { describe, expect, it } from "vitest";
import { calculateNarrowRangeRebalance, narrowTicksAround } from "@/lib/narrow-range-rebalance";

describe("narrow range rebalance", () => {
  it("selects a three-interval range around the current price interval", () => {
    expect(narrowTicksAround(-199745)).toEqual({
      lowerTick: -199860,
      upperTick: -199680
    });
  });

  it("selects the active tick interval for the narrowest range", () => {
    expect(narrowTicksAround(-199745, 1)).toEqual({
      lowerTick: -199800,
      upperTick: -199740
    });
  });

  it("expands range width by tick-spacing intervals", () => {
    expect(narrowTicksAround(-199745, 5)).toEqual({
      lowerTick: -199920,
      upperTick: -199620
    });
  });

  it("asks to swap excess WETH into USDC", () => {
    const result = calculateNarrowRangeRebalance({
      weth: 1,
      usdc: 0,
      price: 2000,
      lowerPrice: 1994,
      upperPrice: 2006
    });

    expect(result.swap.direction).toBe("weth_to_usdc");
    expect(result.swap.spendSymbol).toBe("WETH");
    expect(result.swap.receiveSymbol).toBe("USDC");
    expect(result.swap.spendAmount).toBeGreaterThan(0);
    expect(result.swap.idealReceiveAmount).toBeGreaterThan(0);
    expect(result.target?.weth).toBeLessThan(1);
    expect(result.target?.usdc).toBeGreaterThan(0);
  });

  it("asks to swap excess USDC into WETH", () => {
    const result = calculateNarrowRangeRebalance({
      weth: 0,
      usdc: 2000,
      price: 2000,
      lowerPrice: 1994,
      upperPrice: 2006
    });

    expect(result.swap.direction).toBe("usdc_to_weth");
    expect(result.swap.spendSymbol).toBe("USDC");
    expect(result.swap.receiveSymbol).toBe("WETH");
    expect(result.swap.spendAmount).toBeGreaterThan(0);
    expect(result.swap.idealReceiveAmount).toBeGreaterThan(0);
    expect(result.target?.weth).toBeGreaterThan(0);
    expect(result.target?.usdc).toBeLessThan(2000);
  });
});
