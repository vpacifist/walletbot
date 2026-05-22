import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, parseUnits } from "viem";
import { positionManagerAbi } from "@/lib/abi";
import { CONTRACTS } from "@/lib/constants";
import {
  amountsToPortfolioSnapshot,
  executableWethSellPrice,
  getNextLpAssetAmounts,
  getTransactionAssetDelta,
  getTransactionLpDelta,
  getTransactionPositionLiquidityDeltas,
  subtractDelta
} from "@/lib/wallet-assets";

const walletAddress = "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45";
const wethWithdrawalAbi = [
  {
    type: "event",
    name: "Withdrawal",
    inputs: [
      { indexed: true, name: "src", type: "address" },
      { indexed: false, name: "wad", type: "uint256" }
    ]
  }
] as const;

describe("wallet asset transaction states", () => {
  it("extracts whitelist token and native ETH deltas", () => {
    const delta = getTransactionAssetDelta(
      {
        fromAddress: walletAddress,
        toAddress: "0x1111111111111111111111111111111111111111",
        tokenAmounts: [
          { symbol: "WETH", amount: "1.25", direction: "in" },
          { symbol: "USDC", amount: "100", direction: "out" },
          { symbol: "AERO", amount: "50", direction: "in" },
          { symbol: "SPAM", amount: "999999", direction: "in" }
        ],
        raw: {
          blockscout: { value: "2000000000000000000" },
          receipt: { gasUsed: "21000", effectiveGasPrice: "1000000000" }
        }
      },
      walletAddress
    );

    expect(delta.weth).toBe(1.25);
    expect(delta.usdc).toBe(-100);
    expect(delta.aero).toBe(50);
    expect(delta.eth).toBeCloseTo(-2.000021);
  });

  it("walks backward from the latest wallet state", () => {
    expect(subtractDelta({ weth: 3, usdc: 500, aero: 20, eth: 1 }, { weth: 1, usdc: -100, aero: 5, eth: -0.1 })).toEqual({
      weth: 2,
      usdc: 600,
      aero: 15,
      eth: 1.1
    });
  });

  it("credits LP exit WETH unwraps as native ETH received by the wallet", () => {
    const withdrawalTopics = encodeEventTopics({
      abi: wethWithdrawalAbi,
      eventName: "Withdrawal",
      args: { src: CONTRACTS.nonfungiblePositionManager }
    });
    const walletAddressWord = walletAddress.toLowerCase().slice(2).padStart(64, "0");
    const delta = getTransactionAssetDelta(
      {
        fromAddress: walletAddress,
        toAddress: CONTRACTS.nonfungiblePositionManager,
        type: "lp_exit",
        tokenAmounts: [{ symbol: "USDC", amount: "0.078962", direction: "in" }],
        raw: {
          blockscout: {
            value: "0",
            decoded_input: {
              parameters: [
                {
                  name: "data",
                  value: [`0x49404b7c${"0".repeat(64)}${walletAddressWord}`]
                }
              ]
            }
          },
          receipt: {
            gasUsed: "0",
            effectiveGasPrice: "0",
            logs: [
              {
                address: CONTRACTS.weth,
                data: encodeAbiParameters([{ type: "uint256" }], [parseUnits("3.5305877339550573", 18)]),
                topics: withdrawalTopics
              }
            ]
          }
        }
      },
      walletAddress
    );

    expect(delta.eth).toBeCloseTo(3.5305877339550573);
    expect(delta.usdc).toBe(0.078962);
  });

  it("credits LP decrease WETH unwraps as native ETH received by the wallet", () => {
    const withdrawalTopics = encodeEventTopics({
      abi: wethWithdrawalAbi,
      eventName: "Withdrawal",
      args: { src: CONTRACTS.nonfungiblePositionManager }
    });
    const walletAddressWord = walletAddress.toLowerCase().slice(2).padStart(64, "0");
    const delta = getTransactionAssetDelta(
      {
        fromAddress: walletAddress,
        toAddress: CONTRACTS.nonfungiblePositionManager,
        type: "lp_decrease",
        tokenAmounts: [],
        raw: {
          blockscout: {
            value: "0",
            decoded_input: {
              parameters: [
                {
                  name: "data",
                  value: [`0x49404b7c${"0".repeat(64)}${walletAddressWord}`]
                }
              ]
            }
          },
          receipt: {
            gasUsed: "0",
            effectiveGasPrice: "0",
            logs: [
              {
                address: CONTRACTS.weth,
                data: encodeAbiParameters([{ type: "uint256" }], [parseUnits("3.5305877339550573", 18)]),
                topics: withdrawalTopics
              }
            ]
          }
        }
      },
      walletAddress
    );

    expect(delta.eth).toBeCloseTo(3.5305877339550573);
  });

  it("moves LP deposits into LP balances and portfolio total", () => {
    const transaction = {
      fromAddress: walletAddress,
      toAddress: "0x1111111111111111111111111111111111111111",
      type: "lp_deposit",
      tokenAmounts: [
        { symbol: "WETH", amount: "2", direction: "out" },
        { symbol: "USDC", amount: "1000", direction: "out" }
      ],
      raw: { blockscout: { value: "0" }, receipt: { gasUsed: "0", effectiveGasPrice: "0" } }
    };

    expect(getTransactionLpDelta(transaction)).toEqual({ weth: 2, usdc: 1000 });
    expect(amountsToPortfolioSnapshot({ weth: 1, usdc: 100, aero: 10, eth: 0 }, { weth: 2, usdc: 1000 }, 2000, 0.5).totalUsd).toBe(7105);
  });

  it("values WETH with an executable sell reference instead of gross pool mid", () => {
    expect(executableWethSellPrice(2126.684630056476, 3000)).toBeCloseTo(2120.3045761663066);
    expect(executableWethSellPrice(2122.6479671332313, 100)).toBeCloseTo(2122.435702336518);
  });

  it("uses Aerodrome Slipstream IncreaseLiquidity logs for strategy LP increases", () => {
    const topics = encodeEventTopics({
      abi: positionManagerAbi,
      eventName: "IncreaseLiquidity",
      args: { tokenId: 50443402n }
    });
    const transaction = {
      fromAddress: walletAddress,
      toAddress: CONTRACTS.aerodromeNftFarmStrategy,
      type: "lp_increase",
      tokenAmounts: [
        { symbol: "WETH", amount: "0.172616050263152195", direction: "out" },
        { symbol: "USDC", amount: "1.213639", direction: "in" }
      ],
      raw: {
        blockscout: {
          decoded_input: {
            parameters: [
              {
                value: [
                  CONTRACTS.weth,
                  CONTRACTS.usdc,
                  "500"
                ]
              }
            ]
          }
        },
        receipt: {
          logs: [
            {
              address: CONTRACTS.aerodromeNonfungiblePositionManager,
              data: encodeAbiParameters(
                [
                  { type: "uint128" },
                  { type: "uint256" },
                  { type: "uint256" }
                ],
                [1n, parseUnits("0.130557727706596549", 18), parseUnits("83.928593", 6)]
              ),
              topics
            }
          ]
        }
      }
    };

    expect(getTransactionLpDelta(transaction)).toEqual({
      weth: 0.13055772770659654,
      usdc: 83.928593
    });
  });

  it("closes tracked LP balances on strategy exit", () => {
    expect(
      getNextLpAssetAmounts(
        { weth: 2, usdc: 1000 },
        {
          fromAddress: "0x1111111111111111111111111111111111111111",
          toAddress: walletAddress,
          type: "lp_exit",
          tokenAmounts: [{ symbol: "WETH", amount: "3", direction: "in" }],
          raw: {}
        }
      )
    ).toEqual({ weth: 0, usdc: 0 });
  });

  it("extracts signed position liquidity changes from manager logs", () => {
    const increaseTopics = encodeEventTopics({
      abi: positionManagerAbi,
      eventName: "IncreaseLiquidity",
      args: { tokenId: 5151970n }
    });
    const decreaseTopics = encodeEventTopics({
      abi: positionManagerAbi,
      eventName: "DecreaseLiquidity",
      args: { tokenId: 5151970n }
    });

    expect(
      getTransactionPositionLiquidityDeltas({
        fromAddress: walletAddress,
        type: "lp_decrease",
        tokenAmounts: [],
        raw: {
          receipt: {
            logs: [
              {
                address: CONTRACTS.nonfungiblePositionManager,
                data: encodeAbiParameters(
                  [
                    { type: "uint128" },
                    { type: "uint256" },
                    { type: "uint256" }
                  ],
                  [100n, parseUnits("1", 18), parseUnits("1000", 6)]
                ),
                topics: increaseTopics
              },
              {
                address: CONTRACTS.nonfungiblePositionManager,
                data: encodeAbiParameters(
                  [
                    { type: "uint128" },
                    { type: "uint256" },
                    { type: "uint256" }
                  ],
                  [40n, 0n, parseUnits("400", 6)]
                ),
                topics: decreaseTopics
              }
            ]
          }
        }
      })
    ).toEqual([{ tokenId: "5151970", delta: 60n }]);
  });
});
