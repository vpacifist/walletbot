import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchWalletTransactions: vi.fn(),
  getConfig: vi.fn(),
  prisma: {
    wallet: {
      upsert: vi.fn(),
      update: vi.fn()
    },
    syncRun: {
      create: vi.fn(),
      update: vi.fn()
    },
    transaction: {
      findMany: vi.fn(),
      upsert: vi.fn()
    },
    position: {
      findMany: vi.fn(),
      update: vi.fn()
    }
  },
  createBaseClient: vi.fn(),
  classifyTransaction: vi.fn(),
  applyPositionLifecycleClassification: vi.fn(),
  updatePositionLiquidityState: vi.fn(),
  upsertTrackedPositions: vi.fn(),
  getWethUsdcUniswapV3PoolAddresses: vi.fn()
}));

vi.mock("@/lib/blockscout", () => ({
  fetchWalletTransactions: mocks.fetchWalletTransactions
}));

vi.mock("@/lib/config", () => ({
  getConfig: mocks.getConfig
}));

vi.mock("@/lib/db", () => ({
  prisma: mocks.prisma
}));

vi.mock("@/lib/chain", () => ({
  baseRpcUrlsWithPublicFallback: vi.fn(() => []),
  baseRpcUrls: vi.fn(() => []),
  createBaseClient: mocks.createBaseClient,
  createBaseClientForUrl: vi.fn()
}));

vi.mock("@/lib/classifier", () => ({
  classifyTransaction: mocks.classifyTransaction
}));

vi.mock("@/lib/lp-lifecycle", () => ({
  applyPositionLifecycleClassification: mocks.applyPositionLifecycleClassification,
  updatePositionLiquidityState: mocks.updatePositionLiquidityState
}));

vi.mock("@/lib/positions", () => ({
  calculateRangeStatus: vi.fn((input: { liquidity: bigint; tickLower: number; tickUpper: number; currentTick: number }) => {
    if (input.liquidity === 0n) return "closed_or_zero_liquidity";
    if (input.currentTick < input.tickLower) return "below_range";
    if (input.currentTick >= input.tickUpper) return "above_range";
    return "in_range";
  }),
  upsertTrackedPositions: mocks.upsertTrackedPositions
}));

vi.mock("@/lib/uniswap-v3", () => ({
  getWethUsdcUniswapV3PoolAddresses: mocks.getWethUsdcUniswapV3PoolAddresses
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
  }, 10_000);
});

describe("syncWalletOnce", () => {
  it("refreshes existing active positions from their stored pool even when no new transactions are discovered", async () => {
    const { syncWalletOnce } = await import("@/lib/sync");
    mocks.getConfig.mockReturnValue({
      BASE_WALLET_ADDRESS: walletAddress,
      BASE_RPC_URL: "https://rpc.example",
      BASE_RPC_ADD_URLS: "",
      AUTOPILOT_REBALANCER_ADDRESS: "",
      AUTOPILOT_REBALANCER_ADDRESSES: "",
      AUTOPILOT_EXECUTOR_ADDRESS: ""
    });
    mocks.prisma.wallet.upsert.mockResolvedValue({
      id: "wallet-1",
      address: walletAddress,
      lastSyncedBlock: 47350000n
    });
    mocks.prisma.syncRun.create.mockResolvedValue({ id: "sync-1" });
    mocks.fetchWalletTransactions.mockResolvedValue([]);
    mocks.getWethUsdcUniswapV3PoolAddresses.mockResolvedValue(new Set());
    mocks.prisma.transaction.findMany.mockResolvedValue([]);
    mocks.prisma.position.findMany.mockResolvedValue([
      {
        id: "position-1",
        poolAddress: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
        token0: "0x4200000000000000000000000000000000000006",
        token1: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        tickLower: -201840,
        tickUpper: -201600,
        liquidity: "952862612136224"
      }
    ]);
    mocks.prisma.position.update.mockResolvedValue({});
    mocks.upsertTrackedPositions.mockResolvedValue([]);
    mocks.prisma.wallet.update.mockResolvedValue({});
    mocks.prisma.syncRun.update.mockResolvedValue({});
    mocks.createBaseClient.mockReturnValue({
      readContract: vi.fn().mockResolvedValue([0n, -201836])
    });

    const result = await syncWalletOnce();

    expect(mocks.prisma.position.findMany).toHaveBeenCalledWith({
      where: {
        walletId: "wallet-1",
        poolAddress: { not: null },
        liquidity: { not: "0" }
      },
      select: {
        id: true,
        poolAddress: true,
        token0: true,
        token1: true,
        tickLower: true,
        tickUpper: true,
        liquidity: true
      }
    });
    expect(mocks.upsertTrackedPositions).not.toHaveBeenCalled();
    expect(mocks.prisma.position.update).toHaveBeenCalledWith({
      where: { id: "position-1" },
      data: expect.objectContaining({
        currentTick: -201836,
        status: "in_range",
        lastCheckedAt: expect.any(Date)
      })
    });
    expect(result).toMatchObject({ transactionsSeen: 0, positionsSeen: 1 });
  });
});
