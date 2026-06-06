export type RebalanceSwapSummary = {
  side: "buy_weth" | "sell_weth";
  wethAmount: number;
  usdcAmount: number;
  effectivePrice: number;
  notionalUsd: number;
};

export function rebalanceSwapSummary(swap: {
  side: "buy_weth" | "sell_weth";
  wethAmount: number;
  usdcAmount: number;
  effectivePrice: number;
}): RebalanceSwapSummary | null {
  const notionalUsd = Math.abs(swap.usdcAmount);
  const fallbackNotionalUsd = Math.abs(swap.wethAmount * swap.effectivePrice);
  const normalizedNotionalUsd = Number.isFinite(notionalUsd) && notionalUsd > 0 ? notionalUsd : fallbackNotionalUsd;

  if (!Number.isFinite(normalizedNotionalUsd) || normalizedNotionalUsd <= 0) return null;

  return {
    side: swap.side,
    wethAmount: swap.wethAmount,
    usdcAmount: swap.usdcAmount,
    effectivePrice: swap.effectivePrice,
    notionalUsd: normalizedNotionalUsd
  };
}

export function rebalanceImpermanentLossUsd(
  current: Pick<RebalanceSwapSummary, "side" | "wethAmount" | "effectivePrice"> | null | undefined,
  previous: Pick<RebalanceSwapSummary, "side" | "wethAmount" | "effectivePrice"> | null | undefined
) {
  if (!current || !previous || current.side === previous.side) return null;
  if (
    !Number.isFinite(current.wethAmount) ||
    !Number.isFinite(previous.wethAmount) ||
    !Number.isFinite(current.effectivePrice) ||
    !Number.isFinite(previous.effectivePrice)
  ) {
    return null;
  }

  const matchedWethAmount = Math.min(Math.abs(current.wethAmount), Math.abs(previous.wethAmount));
  if (matchedWethAmount <= 0) return null;

  const sellPrice = current.side === "sell_weth" ? current.effectivePrice : previous.effectivePrice;
  const buyPrice = current.side === "buy_weth" ? current.effectivePrice : previous.effectivePrice;

  return Math.max(0, buyPrice - sellPrice) * matchedWethAmount;
}
