import { describe, expect, it } from "vitest";
import { getApprovalBadge, isApprovalTransaction, mapApprovalsToTransactions } from "@/lib/approvals";

const wallet = "0x5551266bcf3e7a86da53D53CaE370e8aA31CDf45";
const spender = "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5";
const token = "0x940181a94A35A4569E4529A3CDfB74e38FD98631";

function tx(overrides: Record<string, unknown>) {
  return {
    id: "tx",
    hash: "0xhash",
    blockNumber: 1n,
    timestamp: new Date("2026-05-18T09:15:03.000Z"),
    fromAddress: wallet,
    toAddress: token,
    raw: {},
    ...overrides
  };
}

describe("approval presentation helpers", () => {
  it("detects ERC-20 approval transactions", () => {
    const approval = tx({
      raw: {
        blockscout: {
          decoded_input: {
            method_call: "approve(address spender, uint256 amount)",
            parameters: [
              { name: "spender", value: spender },
              { name: "amount", value: "230623109749047604138" }
            ]
          }
        }
      }
    });

    expect(isApprovalTransaction(approval)).toBe(true);
    expect(getApprovalBadge(approval)).toEqual({
      hash: "0xhash",
      token,
      spender,
      amount: "230623109749047604138"
    });
  });

  it("maps an approval to the next transaction sent to the approved spender", () => {
    const approval = tx({
      id: "approval",
      blockNumber: 10n,
      raw: {
        blockscout: {
          decoded_input: {
            method_call: "approve(address spender, uint256 amount)",
            parameters: [
              { name: "spender", value: spender },
              { name: "amount", value: "230623109749047604138" }
            ]
          }
        }
      }
    });
    const target = tx({
      id: "swap",
      hash: "0xswap",
      blockNumber: 11n,
      timestamp: new Date("2026-05-18T09:15:21.000Z"),
      toAddress: spender
    });

    expect(mapApprovalsToTransactions([target, approval]).get("swap")).toEqual([expect.objectContaining({ hash: "0xhash", spender })]);
  });

  it("keeps only the latest pending approval for the same token and spender", () => {
    const olderApproval = tx({
      id: "older-approval",
      hash: "0xolder",
      blockNumber: 9n,
      raw: {
        blockscout: {
          decoded_input: {
            method_call: "approve(address spender, uint256 amount)",
            parameters: [
              { name: "spender", value: spender },
              { name: "amount", value: "100" }
            ]
          }
        }
      }
    });
    const newerApproval = tx({
      id: "newer-approval",
      hash: "0xnewer",
      blockNumber: 10n,
      raw: {
        blockscout: {
          decoded_input: {
            method_call: "approve(address spender, uint256 amount)",
            parameters: [
              { name: "spender", value: spender },
              { name: "amount", value: "200" }
            ]
          }
        }
      }
    });
    const target = tx({
      id: "swap",
      hash: "0xswap",
      blockNumber: 11n,
      timestamp: new Date("2026-05-18T09:15:21.000Z"),
      toAddress: spender
    });

    expect(mapApprovalsToTransactions([target, newerApproval, olderApproval]).get("swap")).toEqual([
      expect.objectContaining({ hash: "0xnewer", amount: "200" })
    ]);
  });
});
