import { PositionStatus, type Position } from "@prisma/client";

function tokenIdSortValue(tokenId: string) {
  try {
    return BigInt(tokenId);
  } catch {
    return 0n;
  }
}

function positionStatusRank(status: PositionStatus) {
  return status === PositionStatus.closed_or_zero_liquidity ? 1 : 0;
}

export function sortPositionsForDisplay<T extends Pick<Position, "status" | "tokenId" | "createdAt">>(positions: T[]) {
  return [...positions].sort((left, right) => {
    const statusDelta = positionStatusRank(left.status) - positionStatusRank(right.status);
    if (statusDelta !== 0) return statusDelta;

    const leftTokenId = tokenIdSortValue(left.tokenId);
    const rightTokenId = tokenIdSortValue(right.tokenId);
    if (leftTokenId !== rightTokenId) return leftTokenId > rightTokenId ? -1 : 1;

    return right.createdAt.getTime() - left.createdAt.getTime();
  });
}
