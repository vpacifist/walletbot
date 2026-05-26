import { PositionStatus, type Position, TransactionType } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { calculateAutopilotPlan } from "@/lib/autopilot-plan";
import { CONTRACTS } from "@/lib/constants";

function position(input: Partial<Position> & Pick<Position, "id" | "tokenId" | "tickLower" | "tickUpper" | "status">): Position {
  return {
    walletId: "wallet",
    poolAddress: "pool",
    token0: CONTRACTS.weth,
    token1: CONTRACTS.usdc,
    fee: 3000,
    currentTick: -199845,
    liquidity: "1",
    wethAmount: "1",
    usdcAmount: "0",
    lastAlertStatus: null,
    lastCheckedAt: null,
    raw: null,
    createdAt: new Date("2026-05-25T00:00:00.000Z"),
    updatedAt: new Date("2026-05-25T00:00:00.000Z"),
    ...input
  };
}

describe("calculateAutopilotPlan", () => {
  it("tracks reversal debt from the latest directional swap", () => {
    const plan = calculateAutopilotPlan({
      positions: [
        position({ id: "active", tokenId: "1", tickLower: -199860, tickUpper: -199800, status: PositionStatus.in_range }),
        position({ id: "upper", tokenId: "2", tickLower: -199800, tickUpper: -199740, status: PositionStatus.above_range })
      ],
      transactions: [
        {
          timestamp: new Date("2026-05-25T21:02:53.000Z"),
          hash: "0xswap",
          protocol: "Matcha/0x v2",
          type: TransactionType.swap,
          tokenAmounts: [
            { symbol: "WETH", amount: "1", direction: "in" },
            { symbol: "USDC", amount: "2200", direction: "out" }
          ]
        }
      ],
      walletWeth: 0,
      walletUsdc: 0,
      currentTick: -199845,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc
    });

    expect(plan.economics.lastDirectionalSwap?.side).toBe("buy_weth");
    expect(plan.economics.reversalDebtUsd).toBeGreaterThan(100);
  });

  it("plans missing ranges without treating a balanced ladder as executable", () => {
    const plan = calculateAutopilotPlan({
      positions: [
        position({ id: "active", tokenId: "1", tickLower: -199860, tickUpper: -199800, status: PositionStatus.in_range }),
        position({ id: "upper", tokenId: "2", tickLower: -199800, tickUpper: -199740, status: PositionStatus.above_range })
      ],
      transactions: [],
      walletWeth: 0,
      walletUsdc: 0,
      currentTick: -199845,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc
    });

    expect(plan.state).toBe("confirming");
    expect(plan.actions.some((action) => action.type === "mint")).toBe(true);
  });

  it("attaches a quote request for stale WETH reused as a lower guard", () => {
    const plan = calculateAutopilotPlan({
      positions: [
        position({ id: "active", tokenId: "1", tickLower: -199860, tickUpper: -199800, status: PositionStatus.in_range }),
        position({ id: "upper", tokenId: "2", tickLower: -199800, tickUpper: -199740, status: PositionStatus.above_range }),
        position({ id: "stale", tokenId: "3", tickLower: -199740, tickUpper: -199680, status: PositionStatus.below_range })
      ],
      transactions: [],
      walletWeth: 0,
      walletUsdc: 0,
      currentTick: -199845,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc
    });
    const partialSwap = plan.actions.find((action) => action.type === "partial_swap");

    expect(partialSwap?.quoteRequest?.spendSymbol).toBe("WETH");
    expect(partialSwap?.quoteRequest?.receiveSymbol).toBe("USDC");
    expect(partialSwap?.quoteRequest?.amountIn).toBeGreaterThan(0);
  });
});
