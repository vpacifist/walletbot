import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const walletAddress = "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45";

function tx(hash: string, blockNumber: number) {
  return {
    hash,
    block_number: blockNumber,
    timestamp: "2026-05-19T00:00:00Z",
    from: { hash: walletAddress },
    to: null,
    value: "0"
  };
}

async function importBlockscout() {
  vi.resetModules();
  process.env.DATABASE_URL = "postgresql://walletbot:walletbot@localhost:5433/walletbot?schema=public";
  process.env.BASE_WALLET_ADDRESS = walletAddress;
  process.env.BASE_RPC_URL = "https://example.com/rpc";
  process.env.BLOCKSCOUT_BASE_URL = "https://blockscout.example";

  return import("@/lib/blockscout");
}

describe("fetchWalletTransactions", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries retryable Blockscout failures", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response("temporary failure", { status: 500 }))
      .mockResolvedValueOnce(
        Response.json({
          items: [tx("0x2", 2)],
          next_page_params: null
        })
      );

    vi.stubGlobal("fetch", fetchMock);
    const { fetchWalletTransactions } = await importBlockscout();

    const resultPromise = fetchWalletTransactions(walletAddress);
    await vi.advanceTimersByTimeAsync(750);
    const result = await resultPromise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.map((item) => item.hash)).toEqual(["0x2"]);
  });

  it("paginates until it reaches the last synced block", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          items: [tx("0x4", 4), tx("0x3", 3)],
          next_page_params: { block_number: 3, index: 1, items_count: 2 }
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          items: [tx("0x2", 2), tx("0x1", 1)],
          next_page_params: { block_number: 1, index: 2, items_count: 2 }
        })
      );

    vi.stubGlobal("fetch", fetchMock);
    const { fetchWalletTransactions } = await importBlockscout();

    const result = await fetchWalletTransactions(walletAddress, 2n);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0].toString()).toContain("block_number=3");
    expect(result.map((item) => item.hash)).toEqual(["0x3", "0x4"]);
  });
});
