import { describe, expect, it } from "vitest";
import { ClassificationStatus, TransactionType } from "@/generated/prisma/client";
import { encodeAbiParameters, encodeEventTopics } from "viem";
import { positionManagerAbi } from "@/lib/abi";
import { applyPositionLifecycleClassification } from "@/lib/lp-lifecycle";
import { CONTRACTS } from "@/lib/constants";

function liquidityLog(params: { eventName: "IncreaseLiquidity" | "DecreaseLiquidity"; tokenId: bigint; liquidity: bigint }) {
  const topics = encodeEventTopics({
    abi: positionManagerAbi,
    eventName: params.eventName,
    args: { tokenId: params.tokenId }
  });

  return {
    address: CONTRACTS.nonfungiblePositionManager,
    data: encodeAbiParameters(
      [
        { type: "uint128" },
        { type: "uint256" },
        { type: "uint256" }
      ],
      [params.liquidity, 0n, 0n]
    ),
    topics
  };
}

describe("applyPositionLifecycleClassification", () => {
  it("classifies a liquidity decrease that closes a position as an LP exit", () => {
    const state = new Map<string, bigint>();
    const tokenId = "5151970";

    applyPositionLifecycleClassification(
      {
        type: TransactionType.lp_deposit,
        status: ClassificationStatus.classified,
        relatedPositionTokenId: tokenId,
        tokenAmounts: []
      },
      state,
      {
        raw: {
          receipt: {
            logs: [liquidityLog({ eventName: "IncreaseLiquidity", tokenId: BigInt(tokenId), liquidity: 100n })]
          }
        }
      }
    );

    const classification = applyPositionLifecycleClassification(
      {
        type: TransactionType.lp_decrease,
        status: ClassificationStatus.classified,
        relatedPositionTokenId: tokenId,
        tokenAmounts: []
      },
      state,
      {
        raw: {
          receipt: {
            logs: [liquidityLog({ eventName: "DecreaseLiquidity", tokenId: BigInt(tokenId), liquidity: 100n })]
          }
        }
      }
    );

    expect(classification.type).toBe(TransactionType.lp_exit);
    expect(classification.relatedPositionTokenId).toBe(tokenId);
    expect(state.get(tokenId)).toBe(0n);
  });

  it("keeps partial liquidity decreases as LP decreases", () => {
    const state = new Map<string, bigint>([["5151970", 100n]]);

    const classification = applyPositionLifecycleClassification(
      {
        type: TransactionType.lp_decrease,
        status: ClassificationStatus.classified,
        relatedPositionTokenId: "5151970",
        tokenAmounts: []
      },
      state,
      {
        raw: {
          receipt: {
            logs: [liquidityLog({ eventName: "DecreaseLiquidity", tokenId: 5151970n, liquidity: 40n })]
          }
        }
      }
    );

    expect(classification.type).toBe(TransactionType.lp_decrease);
    expect(state.get("5151970")).toBe(60n);
  });
});
