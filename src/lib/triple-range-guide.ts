import { type Position } from "@/generated/prisma/client";
import { type Address } from "viem";
import { CONTRACTS } from "./constants";
import { priceFromTick, WETH_USDC_NARROW_FEE, WETH_USDC_NARROW_TICK_SPACING } from "./narrow-range-rebalance";

export type TripleRangeRole = "lower" | "active" | "upper";
export type TripleRangeState = "ok" | "warn" | "missing";
export type TripleRangeSeverity = "good" | "warn" | "bad";

type PositionLike = Pick<
  Position,
  "id" | "tokenId" | "fee" | "tickLower" | "tickUpper" | "status" | "wethAmount" | "usdcAmount" | "liquidity"
>;

export type TripleRangeSegment = {
  role: TripleRangeRole;
  label: string;
  expected: "USDC" | "WETH + USDC" | "WETH";
  lowerTick: number;
  upperTick: number;
  lowerPrice: number | null;
  upperPrice: number | null;
  targetUsd: number;
  position: {
    id: string;
    tokenId: string;
    status: string;
    weth: number;
    usdc: number;
    valueUsd: number;
    sharePercent: number;
    driftPercent: number;
  } | null;
  state: TripleRangeState;
  note: string;
};

export type TripleRangeGuide = {
  pool: {
    fee: number;
    tickSpacing: number;
    currentTick: number;
    baseTick: number;
    price: number;
  };
  totals: {
    walletWeth: number | null;
    walletUsdc: number | null;
    walletValueUsd: number;
    positionsValueUsd: number;
    portfolioValueUsd: number;
    targetPerRangeUsd: number;
  };
  segments: TripleRangeSegment[];
  leftovers: {
    tokenId: string;
    tickLower: number;
    tickUpper: number;
    status: string;
    weth: number;
    usdc: number;
    valueUsd: number;
    suggestedUse: string;
  }[];
  recommendation: {
    severity: TripleRangeSeverity;
    title: string;
    detail: string;
    actions: string[];
  };
  updatedAt: string;
};

const ROLES: Array<{ role: TripleRangeRole; label: string; expected: TripleRangeSegment["expected"]; offset: number }> = [
  { role: "lower", label: "Lower guard", expected: "USDC", offset: -1 },
  { role: "active", label: "Working range", expected: "WETH + USDC", offset: 0 },
  { role: "upper", label: "Upper guard", expected: "WETH", offset: 1 }
];

function numericAmount(value?: string | null) {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueUsd(position: PositionLike, price: number) {
  return numericAmount(position.wethAmount) * price + numericAmount(position.usdcAmount);
}

function activePosition(position: PositionLike) {
  return position.status !== "closed_or_zero_liquidity" && position.liquidity !== "0";
}

function segmentState(position: TripleRangeSegment["position"], portfolioValueUsd: number): TripleRangeState {
  if (!position) return "missing";
  if (portfolioValueUsd <= 0) return "warn";
  return Math.abs(position.driftPercent) <= 5 ? "ok" : "warn";
}

function segmentNote(state: TripleRangeState, role: TripleRangeRole, driftPercent: number | null) {
  if (state === "missing") return "Mint this range";
  if (driftPercent === null) return "Portfolio value unavailable";
  if (Math.abs(driftPercent) <= 5) return "Near 33% target";
  const side = driftPercent > 0 ? "above" : "below";
  if (role === "active") return `Working range is ${Math.abs(driftPercent).toFixed(1)}% ${side} target`;
  return `Guard is ${Math.abs(driftPercent).toFixed(1)}% ${side} target`;
}

function formatRangeTicks(lowerTick: number, upperTick: number) {
  return `${lowerTick} to ${upperTick}`;
}

export function calculateTripleRangeGuide(params: {
  positions: PositionLike[];
  walletWeth: number | null;
  walletUsdc: number | null;
  currentTick: number;
  price: number;
  token0: Address;
  token1: Address;
  updatedAt?: Date;
}): TripleRangeGuide {
  const baseTick = Math.floor(params.currentTick / WETH_USDC_NARROW_TICK_SPACING) * WETH_USDC_NARROW_TICK_SPACING;
  const activePositions = params.positions.filter((position) => position.fee === WETH_USDC_NARROW_FEE && activePosition(position));
  const matchedIds = new Set<string>();
  const positionsValueUsd = activePositions.reduce((total, position) => total + valueUsd(position, params.price), 0);
  const walletValueUsd = (params.walletWeth ?? 0) * params.price + (params.walletUsdc ?? 0);
  const portfolioValueUsd = walletValueUsd + positionsValueUsd;
  const targetPerRangeUsd = portfolioValueUsd / 3;

  const segments = ROLES.map((definition): TripleRangeSegment => {
    const lowerTick = baseTick + definition.offset * WETH_USDC_NARROW_TICK_SPACING;
    const upperTick = lowerTick + WETH_USDC_NARROW_TICK_SPACING;
    const match = activePositions.find((position) => position.tickLower === lowerTick && position.tickUpper === upperTick) ?? null;
    if (match) matchedIds.add(match.id);

    const matchedValueUsd = match ? valueUsd(match, params.price) : 0;
    const sharePercent = portfolioValueUsd > 0 ? (matchedValueUsd / portfolioValueUsd) * 100 : 0;
    const driftPercent = sharePercent - 100 / 3;
    const position = match
      ? {
          id: match.id,
          tokenId: match.tokenId,
          status: match.status,
          weth: numericAmount(match.wethAmount),
          usdc: numericAmount(match.usdcAmount),
          valueUsd: matchedValueUsd,
          sharePercent,
          driftPercent
        }
      : null;
    const state = segmentState(position, portfolioValueUsd);

    return {
      role: definition.role,
      label: definition.label,
      expected: definition.expected,
      lowerTick,
      upperTick,
      lowerPrice: priceFromTick({
        tick: lowerTick,
        token0: params.token0,
        token1: params.token1,
        baseToken: CONTRACTS.weth,
        quoteToken: CONTRACTS.usdc
      }),
      upperPrice: priceFromTick({
        tick: upperTick,
        token0: params.token0,
        token1: params.token1,
        baseToken: CONTRACTS.weth,
        quoteToken: CONTRACTS.usdc
      }),
      targetUsd: targetPerRangeUsd,
      position,
      state,
      note: segmentNote(state, definition.role, position?.driftPercent ?? null)
    };
  });

  const leftovers = activePositions
    .filter((position) => !matchedIds.has(position.id))
    .map((position) => {
      const belowTarget = position.tickUpper <= baseTick - WETH_USDC_NARROW_TICK_SPACING;
      const aboveTarget = position.tickLower >= baseTick + WETH_USDC_NARROW_TICK_SPACING * 2;
      return {
        tokenId: position.tokenId,
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        status: position.status,
        weth: numericAmount(position.wethAmount),
        usdc: numericAmount(position.usdcAmount),
        valueUsd: valueUsd(position, params.price),
        suggestedUse: belowTarget
          ? "Close and swap USDC to WETH for the new upper guard"
          : aboveTarget
            ? "Close and swap WETH to USDC for the new lower guard"
            : "Review manually before reusing"
      };
    });

  const missingSegments = segments.filter((segment) => segment.state === "missing");
  const driftedSegments = segments.filter((segment) => segment.state === "warn");
  const actions: string[] = [];

  for (const leftover of leftovers) {
    actions.push(`#${leftover.tokenId}: ${leftover.suggestedUse}`);
  }
  for (const segment of missingSegments) {
    actions.push(`Mint ${segment.label.toLowerCase()} at ticks ${formatRangeTicks(segment.lowerTick, segment.upperTick)}`);
  }
  for (const segment of driftedSegments) {
    if (!segment.position) continue;
    actions.push(
      `Resize #${segment.position.tokenId} toward $${targetPerRangeUsd.toLocaleString("en-US", { maximumFractionDigits: 2 })}`
    );
  }

  const hasBadShape = missingSegments.length > 0 || leftovers.length > 0;
  const recommendation =
    hasBadShape
      ? {
          severity: "bad" as const,
          title: "Rebuild the three-range ladder",
          detail: "The current price interval changed or one of the three adjacent ranges is missing.",
          actions
        }
      : driftedSegments.length > 0
        ? {
            severity: "warn" as const,
            title: "Capital split needs adjustment",
            detail: "All three roles are present, but at least one range is outside the 33% target band.",
            actions
          }
        : {
            severity: "good" as const,
            title: "Triple range is balanced",
            detail: "Lower guard, working range, and upper guard are present and near the 33% target.",
            actions: ["No immediate action"]
          };

  return {
    pool: {
      fee: WETH_USDC_NARROW_FEE,
      tickSpacing: WETH_USDC_NARROW_TICK_SPACING,
      currentTick: params.currentTick,
      baseTick,
      price: params.price
    },
    totals: {
      walletWeth: params.walletWeth,
      walletUsdc: params.walletUsdc,
      walletValueUsd,
      positionsValueUsd,
      portfolioValueUsd,
      targetPerRangeUsd
    },
    segments,
    leftovers,
    recommendation,
    updatedAt: (params.updatedAt ?? new Date()).toISOString()
  };
}
