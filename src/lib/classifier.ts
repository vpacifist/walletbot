import { ClassificationStatus, TransactionType } from "@prisma/client";
import { decodeEventLog, formatUnits, getAddress, type Address, type TransactionReceipt } from "viem";
import { erc20Abi, positionManagerAbi } from "./abi";
import { CONTRACTS, SUPPORTED_TOKEN_SET, TOKEN_META } from "./constants";

export type TokenAmount = {
  token: string;
  symbol: string;
  rawAmount: string;
  amount: string;
  direction: "in" | "out";
};

export type ClassificationResult = {
  type: TransactionType;
  status: ClassificationStatus;
  protocol?: string;
  tokenAmounts: TokenAmount[];
  usdEstimate?: string;
  relatedPositionTokenId?: string;
};

function sameAddress(a?: string | null, b?: string | null) {
  return Boolean(a && b && a.toLowerCase() === b.toLowerCase());
}

function classifyByNpmEvents(receipt: TransactionReceipt) {
  const tokenIds = new Set<string>();
  let sawIncrease = false;
  let sawDecrease = false;
  let sawCollect = false;

  for (const log of receipt.logs) {
    if (!sameAddress(log.address, CONTRACTS.nonfungiblePositionManager)) continue;

    try {
      const parsed = decodeEventLog({
        abi: positionManagerAbi,
        data: log.data,
        topics: log.topics
      });

      if (parsed.eventName === "IncreaseLiquidity") {
        sawIncrease = true;
        tokenIds.add(parsed.args.tokenId.toString());
      }
      if (parsed.eventName === "DecreaseLiquidity") {
        sawDecrease = true;
        tokenIds.add(parsed.args.tokenId.toString());
      }
      if (parsed.eventName === "Collect") {
        sawCollect = true;
        tokenIds.add(parsed.args.tokenId.toString());
      }
      if (parsed.eventName === "Transfer") {
        tokenIds.add(parsed.args.tokenId.toString());
      }
    } catch {
      // Not a position-manager event covered by the MVP ABI.
    }
  }

  const relatedPositionTokenId = [...tokenIds][0];
  if (sawIncrease) return { type: TransactionType.lp_increase, relatedPositionTokenId };
  if (sawDecrease) return { type: TransactionType.lp_decrease, relatedPositionTokenId };
  if (sawCollect) return { type: TransactionType.lp_collect, relatedPositionTokenId };
  if (relatedPositionTokenId) return { type: TransactionType.unknown, relatedPositionTokenId };

  return undefined;
}

function extractTokenAmounts(receipt: TransactionReceipt, walletAddress: Address): TokenAmount[] {
  const wallet = walletAddress.toLowerCase();
  const amounts = new Map<string, bigint>();

  for (const log of receipt.logs) {
    const tokenAddress = log.address.toLowerCase();
    if (!SUPPORTED_TOKEN_SET.has(tokenAddress)) continue;

    try {
      const parsed = decodeEventLog({
        abi: erc20Abi,
        data: log.data,
        topics: log.topics
      });

      if (parsed.eventName !== "Transfer") continue;
      const from = parsed.args.from.toLowerCase();
      const to = parsed.args.to.toLowerCase();
      const value = parsed.args.value;

      if (from === wallet) amounts.set(tokenAddress, (amounts.get(tokenAddress) ?? 0n) - value);
      if (to === wallet) amounts.set(tokenAddress, (amounts.get(tokenAddress) ?? 0n) + value);
    } catch {
      // Ignore unrelated logs.
    }
  }

  return [...amounts.entries()]
    .filter(([, value]) => value !== 0n)
    .map(([token, value]) => {
      const meta = TOKEN_META[token];
      const absolute = value < 0n ? -value : value;
      return {
        token: getAddress(token),
        symbol: meta.symbol,
        rawAmount: absolute.toString(),
        amount: formatUnits(absolute, meta.decimals),
        direction: value > 0n ? "in" : "out"
      };
    });
}

export function classifyTransaction(params: {
  walletAddress: Address;
  fromAddress: Address;
  toAddress?: Address | null;
  receipt: TransactionReceipt;
}): ClassificationResult {
  const lpEvent = classifyByNpmEvents(params.receipt);
  const tokenAmounts = extractTokenAmounts(params.receipt, params.walletAddress);
  const lowerWallet = params.walletAddress.toLowerCase();
  const fromWallet = params.fromAddress.toLowerCase() === lowerWallet;
  const toWallet = params.toAddress?.toLowerCase() === lowerWallet;

  const usdcAmount = tokenAmounts.find((amount) => amount.symbol === "USDC");
  const usdEstimate = usdcAmount?.amount;

  if (lpEvent) {
    return {
      type: lpEvent.type,
      status: lpEvent.type === TransactionType.unknown ? ClassificationStatus.partial : ClassificationStatus.classified,
      protocol: "Uniswap v3",
      tokenAmounts,
      usdEstimate,
      relatedPositionTokenId: lpEvent.relatedPositionTokenId
    };
  }

  if (tokenAmounts.some((amount) => amount.direction === "in") && tokenAmounts.some((amount) => amount.direction === "out")) {
    return {
      type: TransactionType.swap,
      status: ClassificationStatus.partial,
      protocol: "unknown",
      tokenAmounts,
      usdEstimate
    };
  }

  if (toWallet || tokenAmounts.some((amount) => amount.direction === "in")) {
    return {
      type: TransactionType.deposit,
      status: ClassificationStatus.classified,
      tokenAmounts,
      usdEstimate
    };
  }

  if (fromWallet || tokenAmounts.some((amount) => amount.direction === "out")) {
    return {
      type: TransactionType.withdrawal,
      status: ClassificationStatus.classified,
      tokenAmounts,
      usdEstimate
    };
  }

  return {
    type: TransactionType.unknown,
    status: ClassificationStatus.unknown,
    tokenAmounts,
    usdEstimate
  };
}
