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

export function paddedPriceRangeMarkerPosition(input: {
  lowerPrice: number | null;
  upperPrice: number | null;
  currentPrice: number | null;
  paddingPercent: number;
}) {
  const { lowerPrice, upperPrice, currentPrice, paddingPercent } = input;
  const rawPosition = priceRangeMarkerPosition({
    lowerExtendedPrice: lowerPrice,
    upperExtendedPrice: upperPrice,
    currentPrice
  });
  const padding = Math.min(49, Math.max(0, paddingPercent));

  if (
    lowerPrice === null ||
    upperPrice === null ||
    currentPrice === null ||
    !Number.isFinite(lowerPrice) ||
    !Number.isFinite(upperPrice) ||
    !Number.isFinite(currentPrice)
  ) {
    return rawPosition;
  }

  const minPrice = Math.min(lowerPrice, upperPrice);
  const maxPrice = Math.max(lowerPrice, upperPrice);
  if (currentPrice < minPrice || currentPrice > maxPrice) return rawPosition;

  return padding + (rawPosition / 100) * (100 - padding * 2);
}
