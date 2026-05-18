import { describe, expect, it } from "vitest";
import { ClassificationStatus, TransactionType } from "@prisma/client";
import { classifyTransaction } from "@/lib/classifier";
import { CONTRACTS } from "@/lib/constants";

describe("classifyTransaction", () => {
  it("classifies NftFarmStrategy exit calls as lp_exit before deposit heuristics", () => {
    const result = classifyTransaction({
      walletAddress: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45",
      fromAddress: "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45",
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
});
