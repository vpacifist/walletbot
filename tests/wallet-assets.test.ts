import { describe, expect, it } from "vitest";
import { amountsToPortfolioSnapshot, getNextLpAssetAmounts, getTransactionAssetDelta, getTransactionLpDelta, subtractDelta } from "@/lib/wallet-assets";

const walletAddress = "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45";

describe("wallet asset transaction states", () => {
  it("extracts whitelist token and native ETH deltas", () => {
    const delta = getTransactionAssetDelta(
      {
        fromAddress: walletAddress,
        toAddress: "0x1111111111111111111111111111111111111111",
        tokenAmounts: [
          { symbol: "WETH", amount: "1.25", direction: "in" },
          { symbol: "USDC", amount: "100", direction: "out" },
          { symbol: "SPAM", amount: "999999", direction: "in" }
        ],
        raw: {
          blockscout: { value: "2000000000000000000" },
          receipt: { gasUsed: "21000", effectiveGasPrice: "1000000000" }
        }
      },
      walletAddress
    );

    expect(delta.weth).toBe(1.25);
    expect(delta.usdc).toBe(-100);
    expect(delta.eth).toBeCloseTo(-2.000021);
  });

  it("walks backward from the latest wallet state", () => {
    expect(subtractDelta({ weth: 3, usdc: 500, eth: 1 }, { weth: 1, usdc: -100, eth: -0.1 })).toEqual({
      weth: 2,
      usdc: 600,
      eth: 1.1
    });
  });

  it("moves LP deposits into LP balances and portfolio total", () => {
    const transaction = {
      fromAddress: walletAddress,
      toAddress: "0x1111111111111111111111111111111111111111",
      type: "lp_deposit",
      tokenAmounts: [
        { symbol: "WETH", amount: "2", direction: "out" },
        { symbol: "USDC", amount: "1000", direction: "out" }
      ],
      raw: { blockscout: { value: "0" }, receipt: { gasUsed: "0", effectiveGasPrice: "0" } }
    };

    expect(getTransactionLpDelta(transaction)).toEqual({ weth: 2, usdc: 1000 });
    expect(amountsToPortfolioSnapshot({ weth: 1, usdc: 100, eth: 0 }, { weth: 2, usdc: 1000 }, 2000).totalUsd).toBe(7100);
  });

  it("closes tracked LP balances on strategy exit", () => {
    expect(
      getNextLpAssetAmounts(
        { weth: 2, usdc: 1000 },
        {
          fromAddress: "0x1111111111111111111111111111111111111111",
          toAddress: walletAddress,
          type: "lp_exit",
          tokenAmounts: [{ symbol: "WETH", amount: "3", direction: "in" }],
          raw: {}
        }
      )
    ).toEqual({ weth: 0, usdc: 0 });
  });
});
