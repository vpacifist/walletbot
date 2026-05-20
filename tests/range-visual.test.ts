import { describe, expect, it } from "vitest";
import { priceRangeMarkerPosition } from "@/lib/range-visual";

describe("priceRangeMarkerPosition", () => {
  it("places the marker by USDC price inside an ascending range", () => {
    expect(priceRangeMarkerPosition({ lowerExtendedPrice: 100, upperExtendedPrice: 200, currentPrice: 125 })).toBe(25);
  });

  it("handles tick-derived prices that arrive in descending order", () => {
    expect(priceRangeMarkerPosition({ lowerExtendedPrice: 200, upperExtendedPrice: 100, currentPrice: 125 })).toBe(25);
  });

  it("clamps prices outside the extended visual range", () => {
    expect(priceRangeMarkerPosition({ lowerExtendedPrice: 100, upperExtendedPrice: 200, currentPrice: 250 })).toBe(100);
    expect(priceRangeMarkerPosition({ lowerExtendedPrice: 100, upperExtendedPrice: 200, currentPrice: 50 })).toBe(0);
  });
});
