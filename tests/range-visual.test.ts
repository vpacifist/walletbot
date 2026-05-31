import { describe, expect, it } from "vitest";
import { paddedPriceRangeMarkerPosition, priceRangeMarkerPosition } from "@/lib/range-visual";

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

  it("maps in-range prices inside a padded visual band", () => {
    expect(paddedPriceRangeMarkerPosition({ lowerPrice: 100, upperPrice: 200, currentPrice: 100, paddingPercent: 8 })).toBe(8);
    expect(paddedPriceRangeMarkerPosition({ lowerPrice: 100, upperPrice: 200, currentPrice: 150, paddingPercent: 8 })).toBe(50);
    expect(paddedPriceRangeMarkerPosition({ lowerPrice: 100, upperPrice: 200, currentPrice: 200, paddingPercent: 8 })).toBe(92);
  });

  it("keeps out-of-range prices in the outer padded zones", () => {
    expect(paddedPriceRangeMarkerPosition({ lowerPrice: 100, upperPrice: 200, currentPrice: 50, paddingPercent: 8 })).toBe(0);
    expect(paddedPriceRangeMarkerPosition({ lowerPrice: 100, upperPrice: 200, currentPrice: 250, paddingPercent: 8 })).toBe(100);
  });
});
