import { beforeEach, describe, expect, it, vi } from "vitest";
import { quoteBestExecutableSwap } from "@/lib/swap-quote";
import { CONTRACTS } from "@/lib/constants";

vi.mock("@/lib/config", () => ({
  getConfig: () => ({
    AUTOPILOT_SWAP_PROVIDER: "odos",
    AUTOPILOT_SWAP_SLIPPAGE_BPS: 100,
    AUTOPILOT_REBALANCER_ADDRESS: "0x2cE9E26cA42c38F43Fb0DC7604a08A554A3dff9B",
    BASE_WALLET_ADDRESS: "0x5fafB7Cf2332dDA90d9bDd8ff8320e8a50884057",
    ODOS_API_BASE_URL: "https://api.odos.xyz",
    ODOS_API_KEY: "test-key"
  })
}));

vi.mock("@/lib/chain", () => ({
  createBaseClient: vi.fn(() => ({
    simulateContract: vi.fn().mockResolvedValue({
      result: [278725604688483560n, 0n, 0, 85327n]
    })
  }))
}));

describe("quoteBestExecutableSwap", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ detail: "Error getting quote, please try again" }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        })
      )
    );
  });

  it("falls back to executable Uniswap v3 calldata when Odos quote is temporarily unavailable", async () => {
    const quote = await quoteBestExecutableSwap({
      tokenIn: CONTRACTS.usdc,
      tokenOut: CONTRACTS.weth,
      fee: 3000,
      amountIn: 482.5,
      spendSymbol: "USDC",
      receiveSymbol: "WETH"
    });

    expect(quote.source).toBe("Uniswap QuoterV2 fallback after Odos failure");
    expect(quote.sourceType).toBe("uniswap_v3");
    expect(quote.executable).toBe(true);
    expect(quote.amountOutRaw).toBe("278725604688483560");
    expect(quote.executionNote).toContain("Odos was temporarily unavailable: Error getting quote, please try again");
  });
});
