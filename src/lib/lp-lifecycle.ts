import { TransactionType } from "@/generated/prisma/client";
import type { ClassificationResult } from "./classifier";
import { getTransactionPositionLiquidityDeltas } from "./wallet-assets";

type PositionLiquiditySource = {
  raw: unknown;
};

export type PositionLiquidityState = Map<string, bigint>;

function getPositionLiquidityDeltas(transaction: PositionLiquiditySource) {
  return getTransactionPositionLiquidityDeltas({
    fromAddress: "",
    tokenAmounts: [],
    raw: transaction.raw
  });
}

export function updatePositionLiquidityState(state: PositionLiquidityState, transaction: PositionLiquiditySource) {
  for (const liquidityDelta of getPositionLiquidityDeltas(transaction)) {
    const next = (state.get(liquidityDelta.tokenId) ?? 0n) + liquidityDelta.delta;
    state.set(liquidityDelta.tokenId, next > 0n ? next : 0n);
  }
}

export function applyPositionLifecycleClassification(
  classification: ClassificationResult,
  state: PositionLiquidityState,
  transaction: PositionLiquiditySource
): ClassificationResult {
  let nextClassification = classification;

  for (const liquidityDelta of getPositionLiquidityDeltas(transaction)) {
    const previousLiquidity = state.get(liquidityDelta.tokenId) ?? 0n;
    const nextLiquidity = previousLiquidity + liquidityDelta.delta;
    const closesPosition =
      classification.type === TransactionType.lp_decrease &&
      liquidityDelta.delta < 0n &&
      previousLiquidity > 0n &&
      nextLiquidity <= 0n &&
      (!classification.relatedPositionTokenId || classification.relatedPositionTokenId === liquidityDelta.tokenId);

    if (closesPosition) {
      nextClassification = {
        ...classification,
        type: TransactionType.lp_exit,
        relatedPositionTokenId: liquidityDelta.tokenId
      };
    }

    state.set(liquidityDelta.tokenId, nextLiquidity > 0n ? nextLiquidity : 0n);
  }

  return nextClassification;
}
