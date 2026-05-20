export function priceRangeMarkerPosition(input: {
  lowerExtendedPrice: number | null;
  upperExtendedPrice: number | null;
  currentPrice: number | null;
}) {
  const { lowerExtendedPrice, upperExtendedPrice, currentPrice } = input;
  if (
    lowerExtendedPrice === null ||
    upperExtendedPrice === null ||
    currentPrice === null ||
    !Number.isFinite(lowerExtendedPrice) ||
    !Number.isFinite(upperExtendedPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return 50;
  }

  const minPrice = Math.min(lowerExtendedPrice, upperExtendedPrice);
  const maxPrice = Math.max(lowerExtendedPrice, upperExtendedPrice);
  const priceRange = maxPrice - minPrice;
  if (priceRange <= 0) return 50;

  return Math.min(100, Math.max(0, ((currentPrice - minPrice) / priceRange) * 100));
}
