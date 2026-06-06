import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWalletTransactions: vi.fn(),
  getConfig: vi.fn()
}));

vi.mock("@/lib/blockscout", () => ({
  fetchWalletTransactions: mocks.fetchWalletTransactions
}));

vi.mock("@/lib/config", () => ({
  getConfig: mocks.getConfig
}));

vi.mock("@/lib/db", () => ({
  prisma: {}
}));

vi.mock("@/lib/chain", () => ({
  baseRpcUrls: vi.fn(() => []),
  createBaseClient: vi.fn()
}));

vi.mock("@/lib/classifier", () => ({
  classifyTransaction: vi.fn()
}));

vi.mock("@/lib/lp-lifecycle", () => ({
  applyPositionLifecycleClassification: vi.fn(),
  updatePositionLiquidityState: vi.fn()
}));

vi.mock("@/lib/positions", () => ({
  upsertTrackedPositions: vi.fn()
}));

vi.mock("@/lib/uniswap-v3", () => ({
  getWethUsdcUniswapV3PoolAddresses: vi.fn()
}));

const walletAddress = "0x1111111111111111111111111111111111111111";
const executorAddress = "0x2222222222222222222222222222222222222222";
const rebalancerA = "0x3333333333333333333333333333333333333333";
const rebalancerB = "0x4444444444444444444444444444444444444444";
const unrelatedAddress = "0x5555555555555555555555555555555555555555";

function tx(hash: string, blockNumber: number, from: string, to: string | null) {
  return {
    hash,
    block_number: blockNumber,
    timestamp: "2026-06-06T00:00:00.000Z",
    from: { hash: from },
    to: to ? { hash: to } : null,
    value: "0"
  };
}

describe("fetchConfiguredWalletTransactions", () => {
  it("includes executor transactions to current and historical rebalancer addresses", async () => {
    const { fetchConfiguredWalletTransactions } = await import("@/lib/sync");
    mocks.getConfig.mockReturnValue({
      BASE_WALLET_ADDRESS: walletAddress,
      BASE_RPC_URL: "https://rpc.example",
      BASE_RPC_ADD_URLS: "",
      AUTOPILOT_REBALANCER_ADDRESS: rebalancerA,
      AUTOPILOT_REBALANCER_ADDRESSES: `${rebalancerB}, ${rebalancerA}`,
      AUTOPILOT_EXECUTOR_ADDRESS: executorAddress
    });
    mocks.fetchWalletTransactions
      .mockResolvedValueOnce([tx("0xwallet", 102, walletAddress, null)])
      .mockResolvedValueOnce([
        tx("0xexecutor-b", 101, executorAddress, rebalancerB),
        tx("0xexecutor-a", 103, executorAddress, rebalancerA),
        tx("0xunrelated-target", 104, executorAddress, unrelatedAddress),
        tx("0xunrelated-source", 105, walletAddress, rebalancerA)
      ]);

    const result = await fetchConfiguredWalletTransactions(walletAddress, 100n);

    expect(mocks.fetchWalletTransactions).toHaveBeenNthCalledWith(1, walletAddress, 100n);
    expect(mocks.fetchWalletTransactions).toHaveBeenNthCalledWith(2, executorAddress, undefined);
    expect(result.map((transaction) => transaction.hash)).toEqual(["0xexecutor-b", "0xwallet", "0xexecutor-a"]);
  });
});
