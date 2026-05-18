import { describe, expect, it } from "vitest";
import { ClassificationStatus, TransactionType } from "@prisma/client";
import { encodeAbiParameters, encodeEventTopics, parseUnits } from "viem";
import { classifyTransaction } from "@/lib/classifier";
import { erc20Abi, poolAbi, positionManagerAbi } from "@/lib/abi";
import { CONTRACTS } from "@/lib/constants";

describe("classifyTransaction", () => {
  const walletAddress = "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45";
  const poolAddress = "0x1111111111111111111111111111111111111111";

  function transferLog(params: { token: `0x${string}`; from: `0x${string}`; to: `0x${string}`; value: bigint }) {
    const topics = encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: {
        from: params.from,
        to: params.to
      }
    });

    return {
      address: params.token,
      data: encodeAbiParameters([{ type: "uint256" }], [params.value]),
      topics
    };
  }

  function swapLog() {
    const topics = encodeEventTopics({
      abi: poolAbi,
      eventName: "Swap",
      args: {
        sender: walletAddress,
        recipient: walletAddress
      }
    });

    return {
      address: poolAddress,
      data: encodeAbiParameters(
        [
          { type: "int256" },
          { type: "int256" },
          { type: "uint160" },
          { type: "uint128" },
          { type: "int24" }
        ],
        [parseUnits("2.301078", 18), -parseUnits("5000", 6), 0n, 1n, 0]
      ),
      topics
    };
  }

  function increaseLiquidityLog() {
    const topics = encodeEventTopics({
      abi: positionManagerAbi,
      eventName: "IncreaseLiquidity",
      args: {
        tokenId: 50443402n
      }
    });

    return {
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
    };
  }

  it("classifies NftFarmStrategy exit calls as lp_exit before deposit heuristics", () => {
    const result = classifyTransaction({
      walletAddress,
      fromAddress: walletAddress,
      toAddress: CONTRACTS.nftFarmStrategy,
      method: "exit",
      receipt: {
        logs: []
      } as never
    });

    expect(result.type).toBe(TransactionType.lp_exit);
    expect(result.status).toBe(ClassificationStatus.classified);
    expect(result.protocol).toBe("NftFarmStrategy");
  });

  it("classifies NftFarmStrategy deposit calls as lp_deposit before withdrawal heuristics", () => {
    const result = classifyTransaction({
      walletAddress,
      fromAddress: walletAddress,
      toAddress: CONTRACTS.nftFarmStrategy,
      method: "deposit",
      receipt: {
        logs: []
      } as never
    });

    expect(result.type).toBe(TransactionType.lp_deposit);
    expect(result.status).toBe(ClassificationStatus.classified);
    expect(result.protocol).toBe("NftFarmStrategy");
  });

  it("classifies swaps with Swap events from known WETH/USDC Uniswap v3 pools", () => {
    const result = classifyTransaction({
      walletAddress,
      fromAddress: walletAddress,
      toAddress: "0x2222222222222222222222222222222222222222",
      method: "execute",
      receipt: {
        logs: [
          transferLog({
            token: CONTRACTS.usdc,
            from: walletAddress,
            to: poolAddress,
            value: parseUnits("5000", 6)
          }),
          transferLog({
            token: CONTRACTS.weth,
            from: poolAddress,
            to: walletAddress,
            value: parseUnits("2.301078", 18)
          }),
          swapLog()
        ]
      } as never,
      uniswapV3PoolAddresses: new Set([poolAddress.toLowerCase()])
    });

    expect(result.type).toBe(TransactionType.swap);
    expect(result.status).toBe(ClassificationStatus.classified);
    expect(result.protocol).toBe("Uniswap v3");
  });

  it("classifies swaps sent through 0x AllowanceHolder", () => {
    const result = classifyTransaction({
      walletAddress,
      fromAddress: walletAddress,
      toAddress: CONTRACTS.zeroExAllowanceHolder,
      method: "exec",
      receipt: {
        logs: [
          transferLog({
            token: CONTRACTS.usdc,
            from: walletAddress,
            to: CONTRACTS.zeroExAllowanceHolder,
            value: parseUnits("5000", 6)
          }),
          transferLog({
            token: CONTRACTS.weth,
            from: poolAddress,
            to: walletAddress,
            value: parseUnits("2.301078", 18)
          })
        ]
      } as never
    });

    expect(result.type).toBe(TransactionType.swap);
    expect(result.status).toBe(ClassificationStatus.classified);
    expect(result.protocol).toBe("0x");
  });

  it("classifies Aerodrome Slipstream strategy increases as LP increases", () => {
    const result = classifyTransaction({
      walletAddress,
      fromAddress: walletAddress,
      toAddress: CONTRACTS.nftFarmStrategy,
      method: "increase",
      receipt: {
        logs: [
          transferLog({
            token: CONTRACTS.weth,
            from: walletAddress,
            to: CONTRACTS.nftFarmStrategy,
            value: parseUnits("0.172616050263152195", 18)
          }),
          transferLog({
            token: CONTRACTS.usdc,
            from: CONTRACTS.nftFarmStrategy,
            to: walletAddress,
            value: parseUnits("1.213639", 6)
          }),
          increaseLiquidityLog()
        ]
      } as never
    });

    expect(result.type).toBe(TransactionType.lp_increase);
    expect(result.status).toBe(ClassificationStatus.classified);
    expect(result.protocol).toBe("Aerodrome Slipstream");
    expect(result.relatedPositionTokenId).toBe("50443402");
  });
});
