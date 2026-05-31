import { PositionStatus } from "@/generated/prisma/client";
import { describe, expect, it } from "vitest";
import { CONTRACTS } from "@/lib/constants";
import { calculateTripleRangeGuide } from "@/lib/triple-range-guide";

function position(input: {
  id: string;
  tokenId: string;
  tickLower: number;
  tickUpper: number;
  wethAmount?: string;
  usdcAmount?: string;
}) {
  return {
    id: input.id,
    tokenId: input.tokenId,
    fee: 3000,
    tickLower: input.tickLower,
    tickUpper: input.tickUpper,
    status: PositionStatus.in_range,
    wethAmount: input.wethAmount ?? "0",
    usdcAmount: input.usdcAmount ?? "0",
    liquidity: "1"
  };
}

describe("triple range guide", () => {
  it("maps the three adjacent ranges around the current tick", () => {
    const guide = calculateTripleRangeGuide({
      currentTick: -199745,
      price: 2000,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc,
      walletWeth: 0,
      walletUsdc: 0,
      positions: [
        position({ id: "lower", tokenId: "1", tickLower: -199860, tickUpper: -199800, usdcAmount: "1000" }),
        position({ id: "active", tokenId: "2", tickLower: -199800, tickUpper: -199740, wethAmount: "0.25", usdcAmount: "500" }),
        position({ id: "upper", tokenId: "3", tickLower: -199740, tickUpper: -199680, wethAmount: "0.5" })
      ]
    });

    expect(guide.segments.map((segment) => [segment.role, segment.position?.tokenId])).toEqual([
      ["lower", "1"],
      ["active", "2"],
      ["upper", "3"]
    ]);
    expect(guide.recommendation.severity).toBe("good");
  });

  it("recommends reusing the obsolete upper range as a new lower guard after price moves down", () => {
    const guide = calculateTripleRangeGuide({
      currentTick: -199805,
      price: 2000,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc,
      walletWeth: 0,
      walletUsdc: 0,
      positions: [
        position({ id: "old-lower", tokenId: "1", tickLower: -199860, tickUpper: -199800, usdcAmount: "1000" }),
        position({ id: "old-active", tokenId: "2", tickLower: -199800, tickUpper: -199740, wethAmount: "0.5" }),
        position({ id: "old-upper", tokenId: "3", tickLower: -199740, tickUpper: -199680, wethAmount: "0.5" })
      ]
    });

    expect(guide.segments.find((segment) => segment.role === "lower")?.state).toBe("missing");
    expect(guide.segments.find((segment) => segment.role === "active")?.position?.tokenId).toBe("1");
    expect(guide.segments.find((segment) => segment.role === "upper")?.position?.tokenId).toBe("2");
    expect(guide.leftovers[0]).toMatchObject({
      tokenId: "3",
      suggestedUse: "Close and swap WETH to USDC for the new lower guard"
    });
    expect(guide.recommendation.severity).toBe("bad");
  });
});
