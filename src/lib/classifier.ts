import { ClassificationStatus, TransactionType } from "@prisma/client";
import { decodeEventLog, formatUnits, getAddress, type Address, type TransactionReceipt } from "viem";
import { erc20Abi, poolAbi, positionManagerAbi } from "./abi";
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

function classifyByPositionManagerEvents(receipt: TransactionReceipt) {
  const positionManagers = [
    { address: CONTRACTS.nonfungiblePositionManager, protocol: "Uniswap v3" },
    { address: CONTRACTS.aerodromeNonfungiblePositionManager, protocol: "Aerodrome Slipstream" }
  ];
  const tokenIds = new Set<string>();
  let sawIncrease = false;
  let sawDecrease = false;
  let sawCollect = false;
  let protocol: string | undefined;

  for (const log of receipt.logs) {
    const positionManager = positionManagers.find((manager) => sameAddress(log.address, manager.address));
    if (!positionManager) continue;

    try {
      const parsed = decodeEventLog({
        abi: positionManagerAbi,
        data: log.data,
        topics: log.topics
      });

      if (parsed.eventName === "IncreaseLiquidity") {
        sawIncrease = true;
        protocol = positionManager.protocol;
        tokenIds.add(parsed.args.tokenId.toString());
      }
      if (parsed.eventName === "DecreaseLiquidity") {
        sawDecrease = true;
        protocol = positionManager.protocol;
        tokenIds.add(parsed.args.tokenId.toString());
      }
      if (parsed.eventName === "Collect") {
        sawCollect = true;
        protocol = positionManager.protocol;
        tokenIds.add(parsed.args.tokenId.toString());
      }
      if (parsed.eventName === "Transfer") {
        protocol = positionManager.protocol;
        tokenIds.add(parsed.args.tokenId.toString());
      }
    } catch {
      // Not a position-manager event covered by the MVP ABI.
    }
  }

  const relatedPositionTokenId = [...tokenIds][0];
  if (sawIncrease) return { type: TransactionType.lp_increase, relatedPositionTokenId, protocol };
  if (sawDecrease) return { type: TransactionType.lp_decrease, relatedPositionTokenId, protocol };
  if (sawCollect) return { type: TransactionType.lp_collect, relatedPositionTokenId, protocol };
  if (relatedPositionTokenId) return { type: TransactionType.unknown, relatedPositionTokenId, protocol };

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

function hasUniswapV3SwapEvent(receipt: TransactionReceipt, poolAddresses?: ReadonlySet<string>) {
  if (!poolAddresses || poolAddresses.size === 0) return false;

  for (const log of receipt.logs) {
    if (!poolAddresses.has(log.address.toLowerCase())) continue;

    try {
      const parsed = decodeEventLog({
        abi: poolAbi,
        data: log.data,
        topics: log.topics
      });

      if (parsed.eventName === "Swap") return true;
    } catch {
      // Not a Uniswap v3 Swap event.
    }
  }

  return false;
}

function hasLogFromAddress(receipt: TransactionReceipt, address: Address) {
  const lowerAddress = address.toLowerCase();
  return receipt.logs.some((log) => log.address.toLowerCase() === lowerAddress);
}

function isStrategyExit(method?: string, toAddress?: Address | null) {
  return (
    method === "exit" &&
    (sameAddress(toAddress, CONTRACTS.nftFarmStrategy) || sameAddress(toAddress, CONTRACTS.aerodromeNftFarmStrategy))
  );
}

export function classifyTransaction(params: {
  walletAddress: Address;
  fromAddress: Address;
  toAddress?: Address | null;
  method?: string | null;
  receipt: TransactionReceipt;
  uniswapV3PoolAddresses?: ReadonlySet<string>;
}): ClassificationResult {
  const lpEvent = classifyByPositionManagerEvents(params.receipt);
  const tokenAmounts = extractTokenAmounts(params.receipt, params.walletAddress);
  const isUniswapV3Swap = hasUniswapV3SwapEvent(params.receipt, params.uniswapV3PoolAddresses);
  const isZeroExSwap =
    sameAddress(params.toAddress, CONTRACTS.zeroExAllowanceHolder) || hasLogFromAddress(params.receipt, CONTRACTS.zeroExAllowanceHolder);
  const isKyberSwap =
    sameAddress(params.toAddress, CONTRACTS.kyberSwapMetaAggregationRouterV2) ||
    hasLogFromAddress(params.receipt, CONTRACTS.kyberSwapMetaAggregationRouterV2);
  const lowerWallet = params.walletAddress.toLowerCase();
  const fromWallet = params.fromAddress.toLowerCase() === lowerWallet;
  const toWallet = params.toAddress?.toLowerCase() === lowerWallet;
  const method = params.method?.toLowerCase();

  const usdcAmount = tokenAmounts.find((amount) => amount.symbol === "USDC");
  const usdEstimate = usdcAmount?.amount;

  if (isStrategyExit(method, params.toAddress)) {
    return {
      type: TransactionType.lp_exit,
      status: ClassificationStatus.classified,
      protocol: lpEvent?.protocol ?? "NftFarmStrategy",
      tokenAmounts,
      usdEstimate,
      relatedPositionTokenId: lpEvent?.relatedPositionTokenId
    };
  }

  if (lpEvent) {
    return {
      type: lpEvent.type,
      status: lpEvent.type === TransactionType.unknown ? ClassificationStatus.partial : ClassificationStatus.classified,
      protocol: lpEvent.protocol,
      tokenAmounts,
      usdEstimate,
      relatedPositionTokenId: lpEvent.relatedPositionTokenId
    };
  }

  if (method === "deposit" && sameAddress(params.toAddress, CONTRACTS.nftFarmStrategy)) {
    return {
      type: TransactionType.lp_deposit,
      status: ClassificationStatus.classified,
      protocol: "NftFarmStrategy",
      tokenAmounts,
      usdEstimate
    };
  }

  if (tokenAmounts.some((amount) => amount.direction === "in") && tokenAmounts.some((amount) => amount.direction === "out")) {
    const protocol = isUniswapV3Swap ? "Uniswap v3" : isZeroExSwap ? "0x" : isKyberSwap ? "KyberSwap" : "unknown";

    return {
      type: TransactionType.swap,
      status: protocol === "unknown" ? ClassificationStatus.partial : ClassificationStatus.classified,
      protocol,
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
