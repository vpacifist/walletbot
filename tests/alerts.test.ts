import { describe, expect, it } from "vitest";
import { PositionStatus } from "@prisma/client";
import { isOutOfRange } from "@/lib/alerts";

describe("isOutOfRange", () => {
  it("only treats above and below range as alertable", () => {
    expect(isOutOfRange(PositionStatus.above_range)).toBe(true);
    expect(isOutOfRange(PositionStatus.below_range)).toBe(true);
    expect(isOutOfRange(PositionStatus.in_range)).toBe(false);
    expect(isOutOfRange(PositionStatus.closed_or_zero_liquidity)).toBe(false);
    expect(isOutOfRange(PositionStatus.unknown)).toBe(false);
  });
});
