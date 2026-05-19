import { describe, expect, it } from "vitest";
import { CONTRACTS } from "@/lib/constants";
import { getPositionTokenAmounts, tickToWethUsdcPrice } from "@/lib/uniswap-v3-position";

describe("Uniswap v3 position helpers", () => {
  it("formats WETH/USDC tick prices as USDC per WETH", () => {
    const price = tickToWethUsdcPrice(-199824, CONTRACTS.weth, CONTRACTS.usdc);

    expect(price).toBeGreaterThan(2000);
    expect(price).toBeLessThan(2200);
  });

  it("maps in-range token0/token1 amounts to WETH and USDC", () => {
    const amounts = getPositionTokenAmounts({
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc,
      liquidity: 18472290674076962n,
      tickLower: -199920,
      tickUpper: -199740,
      currentTick: -199824
    });

    expect(Number(amounts.weth)).toBeGreaterThan(0);
    expect(Number(amounts.usdc)).toBeGreaterThan(0);
  });
});
