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

  it("credits collected and uncollected fees against reversal debt", () => {
    const plan = calculateAutopilotPlan({
      positions: [
        position({ id: "active", tokenId: "1", tickLower: -199860, tickUpper: -199800, status: PositionStatus.in_range }),
        position({ id: "upper", tokenId: "2", tickLower: -199800, tickUpper: -199740, status: PositionStatus.above_range })
      ],
      transactions: [
        {
          timestamp: new Date("2026-05-25T21:00:00.000Z"),
          hash: "0xswap",
          protocol: "Matcha/0x v2",
          type: TransactionType.swap,
          tokenAmounts: [
            { symbol: "WETH", amount: "1", direction: "in" },
            { symbol: "USDC", amount: "2200", direction: "out" }
          ]
        },
        {
          timestamp: new Date("2026-05-25T21:30:00.000Z"),
          hash: "0xcollect",
          protocol: "Uniswap v3",
          type: TransactionType.lp_collect,
          tokenAmounts: [{ symbol: "USDC", amount: "12", direction: "in" }]
        }
      ],
      walletWeth: 0,
      walletUsdc: 0,
      currentTick: -199845,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc,
      uncollectedFeeCreditUsd: 5
    });

    expect(plan.economics.collectedFeesSinceLastSwapUsd).toBe(12);
    expect(plan.economics.uncollectedFeesUsd).toBe(5);
    expect(plan.economics.feeCreditUsd).toBe(17);
    expect(plan.economics.uncoveredReversalDebtUsd).toBeLessThan(plan.economics.reversalDebtUsd + plan.economics.immediateCostUsd);
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

  it("uses a single 240-tick range in the small-capital preset", () => {
    const plan = calculateAutopilotPlan({
      preset: "small_capital_test",
      positions: [position({ id: "active", tokenId: "1", tickLower: -199980, tickUpper: -199740, status: PositionStatus.in_range })],
      transactions: [],
      walletWeth: 0,
      walletUsdc: 0,
      currentTick: -199845,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc
    });

    expect(plan.strategy.preset).toBe("small_capital_test");
    expect(plan.strategy.targetWidthTicks).toBe(240);
    expect(plan.ladder).toHaveLength(1);
    expect(plan.ladder[0].range).toBe("-199980 - -199740");
    expect(plan.actions[0].type).toBe("hold");
  });

  it("plans a close, split rebalance, and mint after a small-capital breakout", () => {
    const plan = calculateAutopilotPlan({
      preset: "small_capital_test",
      positions: [
        position({
          id: "active",
          tokenId: "1",
          tickLower: -199980,
          tickUpper: -199740,
          status: PositionStatus.above_range,
          wethAmount: "0",
          usdcAmount: "1000"
        })
      ],
      transactions: [],
      walletWeth: 0,
      walletUsdc: 0,
      currentTick: -199700,
      token0: CONTRACTS.weth,
      token1: CONTRACTS.usdc
    });

    expect(plan.strategy.preset).toBe("small_capital_test");
    expect(plan.actions.map((action) => action.type)).toEqual(["close", "partial_swap", "mint"]);
    expect(plan.actions[0].tokenId).toBe("1");
    expect(plan.actions[1].quoteRequest?.spendSymbol).toBe("USDC");
    expect(plan.actions[2].lowerTick).toBe(-199860);
    expect(plan.actions[2].upperTick).toBe(-199620);
  });
});
