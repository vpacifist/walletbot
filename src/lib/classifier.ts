import { ClassificationStatus, TransactionType } from "@/generated/prisma/client";
import { decodeEventLog, formatUnits, getAddress, type Address, type TransactionReceipt } from "viem";
import { erc20Abi, poolAbi, positionManagerAbi } from "./abi";
import { CONTRACTS, SUPPORTED_TOKEN_SET, TOKEN_META } from "./constants";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UNWRAP_WETH9_SELECTOR = "0x49404b7c";
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
  const increaseTokenIds = new Set<string>();
  const mintedTokenIds = new Set<string>();
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
        const tokenId = parsed.args.tokenId.toString();
        tokenIds.add(tokenId);
        increaseTokenIds.add(tokenId);
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
        const tokenId = parsed.args.tokenId.toString();
        tokenIds.add(tokenId);
        if (parsed.args.from.toLowerCase() === ZERO_ADDRESS) mintedTokenIds.add(tokenId);
      }
    } catch {
      // Not a position-manager event covered by the MVP ABI.
    }
  }

  const mintedIncreaseTokenId = [...increaseTokenIds].find((tokenId) => mintedTokenIds.has(tokenId));
  const relatedPositionTokenId = mintedIncreaseTokenId ?? [...tokenIds][0];
  if (mintedIncreaseTokenId) return { type: TransactionType.lp_deposit, relatedPositionTokenId, protocol };
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

function nativeEthTokenAmount(params: { valueWei?: string | null; fromWallet: boolean; toWallet: boolean }): TokenAmount | null {
  if (!params.valueWei) return null;

  try {
    const value = BigInt(params.valueWei);
    if (value === 0n) return null;

    return {
      token: ZERO_ADDRESS,
      symbol: "ETH",
      rawAmount: value.toString(),
      amount: formatUnits(value, 18),
      direction: params.toWallet ? "in" : "out"
    };
  } catch {
    return null;
  }
}

function readRawRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function decodedMulticallBytes(blockscout: Record<string, unknown>) {
  const decodedInput = readRawRecord(blockscout.decoded_input);
  const parameters = Array.isArray(decodedInput.parameters) ? decodedInput.parameters : [];
  const dataParameter = parameters.find((parameter) => {
    if (!parameter || typeof parameter !== "object") return false;
    return (parameter as { name?: string }).name === "data";
  });

  if (!dataParameter || typeof dataParameter !== "object") return [];
  const value = (dataParameter as { value?: unknown }).value;
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unwrapWeth9Recipients(blockscout: Record<string, unknown>) {
  return decodedMulticallBytes(blockscout)
    .filter((callData) => callData.toLowerCase().startsWith(UNWRAP_WETH9_SELECTOR))
    .map((callData) => `0x${callData.slice(-40)}`.toLowerCase());
}

function extractNativeEthFromWethWithdrawals(params: {
  receipt: TransactionReceipt;
  walletAddress: Address;
  blockscout?: unknown;
}): TokenAmount[] {
  const wallet = params.walletAddress.toLowerCase();
  const blockscout = readRawRecord(params.blockscout);
  const sawUnwrapToWallet = unwrapWeth9Recipients(blockscout).includes(wallet);
  let amount = 0n;

  for (const log of params.receipt.logs) {
    if (log.address.toLowerCase() !== CONTRACTS.weth.toLowerCase()) continue;

    try {
      const parsed = decodeEventLog({
        abi: wethWithdrawalAbi,
        data: log.data,
        topics: log.topics
      });

      if (parsed.eventName === "Withdrawal" && (parsed.args.src.toLowerCase() === wallet || sawUnwrapToWallet)) {
        amount += parsed.args.wad;
      }
    } catch {
      // Not a WETH withdrawal event.
    }
  }

  if (amount === 0n) return [];

  return [
    {
      token: ZERO_ADDRESS,
      symbol: "ETH",
      rawAmount: amount.toString(),
      amount: formatUnits(amount, 18),
      direction: "in"
    }
  ];
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

function swapProtocol(params: {
  toAddress?: Address | null;
  receipt: TransactionReceipt;
  isUniswapV3Swap: boolean;
}) {
  if (sameAddress(params.toAddress, CONTRACTS.weth)) {
    return "WETH";
  }
  if (sameAddress(params.toAddress, CONTRACTS.zeroExSettler) || hasLogFromAddress(params.receipt, CONTRACTS.zeroExSettler)) {
    return "Matcha/0x v2";
  }
  if (sameAddress(params.toAddress, CONTRACTS.zeroExAllowanceHolder) || hasLogFromAddress(params.receipt, CONTRACTS.zeroExAllowanceHolder)) {
    return "0x";
  }
  if (
    sameAddress(params.toAddress, CONTRACTS.kyberSwapMetaAggregationRouterV2) ||
    hasLogFromAddress(params.receipt, CONTRACTS.kyberSwapMetaAggregationRouterV2)
  ) {
    return "KyberSwap";
  }
  if (sameAddress(params.toAddress, CONTRACTS.odosSmartOrderRouterV3) || hasLogFromAddress(params.receipt, CONTRACTS.odosSmartOrderRouterV3)) {
    return "Odos";
  }
  if (sameAddress(params.toAddress, CONTRACTS.veloraAugustusV6) || hasLogFromAddress(params.receipt, CONTRACTS.veloraAugustusV6)) {
    return "Velora / ParaSwap";
  }
  if (params.isUniswapV3Swap) return "Uniswap v3";

  return "unknown";
}

export function classifyTransaction(params: {
  walletAddress: Address;
  fromAddress: Address;
  toAddress?: Address | null;
  method?: string | null;
  nativeValueWei?: string | null;
  blockscout?: unknown;
  receipt: TransactionReceipt;
  uniswapV3PoolAddresses?: ReadonlySet<string>;
}): ClassificationResult {
  const lpEvent = classifyByPositionManagerEvents(params.receipt);
  const isUniswapV3Swap = hasUniswapV3SwapEvent(params.receipt, params.uniswapV3PoolAddresses);
  const lowerWallet = params.walletAddress.toLowerCase();
  const fromWallet = params.fromAddress.toLowerCase() === lowerWallet;
  const toWallet = params.toAddress?.toLowerCase() === lowerWallet;
  const method = params.method?.toLowerCase();
  const tokenAmounts = extractTokenAmounts(params.receipt, params.walletAddress);
  const nativeAmount = nativeEthTokenAmount({ valueWei: params.nativeValueWei, fromWallet, toWallet });
  if (nativeAmount && (fromWallet || toWallet)) tokenAmounts.push(nativeAmount);
  tokenAmounts.push(...extractNativeEthFromWethWithdrawals({ receipt: params.receipt, walletAddress: params.walletAddress, blockscout: params.blockscout }));

  const usdcAmount = tokenAmounts.find((amount) => amount.symbol === "USDC");
  const usdEstimate = usdcAmount?.amount;

  if (params.receipt.status === "reverted") {
    return {
      type: TransactionType.failed,
      status: ClassificationStatus.failed,
      protocol: swapProtocol({ toAddress: params.toAddress, receipt: params.receipt, isUniswapV3Swap }),
      tokenAmounts,
      usdEstimate
    };
  }

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
    const protocol = swapProtocol({ toAddress: params.toAddress, receipt: params.receipt, isUniswapV3Swap });

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

  if (tokenAmounts.some((amount) => amount.direction === "out")) {
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
