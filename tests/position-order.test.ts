import { PositionStatus, type Position } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { sortPositionsForDisplay } from "@/lib/position-order";

function position(input: { tokenId: string; status: PositionStatus; updatedAt: Date }): Position {
  const now = new Date("2026-05-22T12:00:00.000Z");
  return {
    id: input.tokenId,
    walletId: "wallet",
    tokenId: input.tokenId,
    poolAddress: null,
    token0: "0x0000000000000000000000000000000000000000",
    token1: "0x0000000000000000000000000000000000000000",
    fee: 3000,
    tickLower: 0,
    tickUpper: 0,
    currentTick: null,
    liquidity: "0",
    wethAmount: null,
    usdcAmount: null,
    status: input.status,
    lastAlertStatus: null,
    lastCheckedAt: null,
    raw: null,
    createdAt: now,
    updatedAt: input.updatedAt
  };
}

describe("sortPositionsForDisplay", () => {
  it("keeps active positions above closed positions regardless of update order", () => {
    const rows = sortPositionsForDisplay([
      position({
        tokenId: "5157741",
        status: PositionStatus.closed_or_zero_liquidity,
        updatedAt: new Date("2026-05-22T12:03:00.000Z")
      }),
      position({
        tokenId: "5166247",
        status: PositionStatus.in_range,
        updatedAt: new Date("2026-05-22T12:01:00.000Z")
      }),
      position({
        tokenId: "5157606",
        status: PositionStatus.closed_or_zero_liquidity,
        updatedAt: new Date("2026-05-22T12:02:00.000Z")
      })
    ]);

    expect(rows.map((row) => row.tokenId)).toEqual(["5166247", "5157741", "5157606"]);
  });
});
