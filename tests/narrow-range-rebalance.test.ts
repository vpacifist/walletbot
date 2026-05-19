import { describe, expect, it } from "vitest";
import { calculateNarrowRangeRebalance } from "@/lib/narrow-range-rebalance";

describe("narrow range rebalance", () => {
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
