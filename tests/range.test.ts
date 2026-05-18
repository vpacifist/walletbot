import { describe, expect, it } from "vitest";
import { PositionStatus } from "@prisma/client";
import { calculateRangeStatus } from "@/lib/positions";

describe("calculateRangeStatus", () => {
  it("marks zero-liquidity positions closed", () => {
    expect(calculateRangeStatus({ liquidity: 0n, tickLower: 10, tickUpper: 20, currentTick: 15 })).toBe(
      PositionStatus.closed_or_zero_liquidity
    );
  });

  it("detects below range", () => {
    expect(calculateRangeStatus({ liquidity: 1n, tickLower: 10, tickUpper: 20, currentTick: 9 })).toBe(PositionStatus.below_range);
  });

  it("detects in range", () => {
    expect(calculateRangeStatus({ liquidity: 1n, tickLower: 10, tickUpper: 20, currentTick: 10 })).toBe(PositionStatus.in_range);
    expect(calculateRangeStatus({ liquidity: 1n, tickLower: 10, tickUpper: 20, currentTick: 19 })).toBe(PositionStatus.in_range);
  });

  it("treats the upper tick as out of range", () => {
    expect(calculateRangeStatus({ liquidity: 1n, tickLower: 10, tickUpper: 20, currentTick: 20 })).toBe(PositionStatus.above_range);
  });
});
