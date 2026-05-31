import { decodeEventLog, formatUnits, type Address } from "viem";
import { erc20Abi, factoryAbi, poolAbi, positionManagerAbi, slipstreamPoolAbi } from "./abi";
import { createBaseClient } from "./chain";
import { CONTRACTS, TOKEN_META, WETH_USDC_FEE_TIERS, WETH_USDC_UNISWAP_V3_POOL_SET } from "./constants";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
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
const SWAP_SETTLEMENT_TARGETS = [
  CONTRACTS.zeroExSettler,
  CONTRACTS.zeroExAllowanceHolder,
  CONTRACTS.uniswapV3SwapRouter02,
  CONTRACTS.kyberSwapMetaAggregationRouterV2,
  CONTRACTS.odosSmartOrderRouterV3,
  CONTRACTS.veloraAugustusV6
].map((address) => address.toLowerCase());
const historicalPriceCache = new Map<string, Promise<number | null>>();
const poolTokenCache = new Map<string, Promise<{ token0: Address; token1: Address }>>();

export type WalletAssetSnapshot = {
  weth: WalletAssetValue;
  usdc: WalletAssetValue;
  aero: WalletAssetValue;
  eth: WalletAssetValue;
  lpWeth?: WalletAssetValue;
  lpUsdc?: WalletAssetValue;
  totalUsd: number | null;
  ethPriceUsd: number | null;
  aeroPriceUsd: number | null;
};

type WalletAssetValue = {
  symbol: "WETH" | "USDC" | "AERO" | "ETH";
  amount: number | null;
  valueUsd: number | null;
};

export type WalletAssetAmounts = {
  weth: number | null;
  usdc: number | null;
  aero: number | null;
  eth: number | null;
};

export type WalletAssetDelta = {
  weth: number;
  usdc: number;
  aero: number;
  eth: number;
};

export type LpAssetAmounts = {
  weth: number | null;
  usdc: number | null;
};

export type LpAssetDelta = {
  weth: number;
  usdc: number;
};

export type PositionLiquidityDelta = {
  tokenId: string;
  delta: bigint;
};

export type PositionExitAmounts = {
  principal: LpAssetAmounts;
  collected: LpAssetAmounts;
  earned: LpAssetAmounts;
};

export type PositionPrincipalDelta = {
  tokenId: string;
  delta: LpAssetDelta;
};

export type TransactionDirectionalSwap = {
  side: "buy_weth" | "sell_weth";
  wethAmount: number;
  usdcAmount: number;
  effectivePrice: number;
  poolAddress: string;
  tick: number;
};

type TokenTransfer = {
  token: string;
  symbol: "WETH" | "USDC";
  from: string;
  to: string;
  amount: number;
};

type TransactionAssetSource = {
  fromAddress: string;
  toAddress?: string | null;
  type?: string;
  tokenAmounts: unknown;
  raw: unknown;
};

type PositionAssetSource = {
  token0: string;
  token1: string;
  tickLower: number;
  tickUpper: number;
  currentTick: number | null;
  liquidity: string;
};

function toNumber(value: bigint, decimals: number) {
  return Number(formatUnits(value, decimals));
}

function valueUsd(amount: number | null, priceUsd: number | null) {
  if (amount === null || priceUsd === null) return null;
  return amount * priceUsd;
}

function sumKnown(values: Array<number | null>) {
  return values.every((value) => value === null) ? null : values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function applyValue(value: number | null, delta: number) {
  if (value === null) return null;
  const next = value - delta;
  return Math.abs(next) < 1e-9 ? 0 : next;
}

function rawStringToEth(value?: unknown) {
  if (typeof value !== "string" || value === "") return 0;

  try {
    return Number(formatUnits(BigInt(value), 18));
  } catch {
    return 0;
  }
}

function readRawRecord(value: unknown) {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function tokenPairFromDecodedInput(value: unknown): [string, string] | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const nestedValue of Object.values(value)) {
      const nested = tokenPairFromDecodedInput(nestedValue);
      if (nested) return nested;
    }
    return null;
  }

  if (!Array.isArray(value)) return null;

  if (
    value.length === 3 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string" &&
    new Set([value[0].toLowerCase(), value[1].toLowerCase()]).size === 2
  ) {
    const pair = new Set([value[0].toLowerCase(), value[1].toLowerCase()]);
    if (pair.has(CONTRACTS.weth.toLowerCase()) && pair.has(CONTRACTS.usdc.toLowerCase())) return [value[0], value[1]];
  }

  for (const item of value) {
    const nested = tokenPairFromDecodedInput(item);
    if (nested) return nested;
  }

  return null;
}

function aerodromeSlipstreamLpDelta(transaction: TransactionAssetSource): LpAssetDelta | null {
  const toAddress = transaction.toAddress?.toLowerCase();
  const isAerodromeStrategy =
    toAddress === CONTRACTS.nftFarmStrategy.toLowerCase() || toAddress === CONTRACTS.aerodromeNftFarmStrategy.toLowerCase();
  if ((transaction.type !== "lp_increase" && transaction.type !== "lp_deposit") || !isAerodromeStrategy) return null;

  const raw = readRawRecord(transaction.raw);
  const blockscout = readRawRecord(raw.blockscout);
  const decodedInput = readRawRecord(blockscout.decoded_input);
  const tokenPair = tokenPairFromDecodedInput(decodedInput.parameters);
  if (!tokenPair) return null;

  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || record.address.toLowerCase() !== CONTRACTS.aerodromeNonfungiblePositionManager.toLowerCase()) continue;
    if (!record.data || !record.topics) continue;

    try {
      const parsed = decodeEventLog({
        abi: positionManagerAbi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName !== "IncreaseLiquidity") continue;

      const [token0, token1] = tokenPair;
      const delta: LpAssetDelta = { weth: 0, usdc: 0 };
      const amount0 = tokenAmountFromRaw(token0, Number(parsed.args.amount0));
      const amount1 = tokenAmountFromRaw(token1, Number(parsed.args.amount1));

      if (token0.toLowerCase() === CONTRACTS.weth.toLowerCase()) delta.weth += amount0;
      if (token1.toLowerCase() === CONTRACTS.weth.toLowerCase()) delta.weth += amount1;
      if (token0.toLowerCase() === CONTRACTS.usdc.toLowerCase()) delta.usdc += amount0;
      if (token1.toLowerCase() === CONTRACTS.usdc.toLowerCase()) delta.usdc += amount1;
      return delta;
    } catch {
      // Not an Aerodrome Slipstream increase-liquidity event.
    }
  }

  return null;
}

function gasCostWei(receipt: Record<string, unknown>) {
  if (typeof receipt.gasUsed !== "string" || typeof receipt.effectiveGasPrice !== "string") return undefined;

  try {
    return (BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice)).toString();
  } catch {
    return undefined;
  }
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

function unwrappedWethAmount(transaction: TransactionAssetSource, walletAddress: Address) {
  const raw = readRawRecord(transaction.raw);
  const blockscout = readRawRecord(raw.blockscout);
  const wallet = walletAddress.toLowerCase();
  const isLpUnwrapToWallet = transaction.type?.startsWith("lp_") && unwrapWeth9Recipients(blockscout).includes(wallet);

  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  let amount = 0;

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || record.address.toLowerCase() !== CONTRACTS.weth.toLowerCase()) continue;
    if (!record.data || !record.topics) continue;

    try {
      const parsed = decodeEventLog({
        abi: wethWithdrawalAbi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName === "Withdrawal" && (parsed.args.src.toLowerCase() === wallet || isLpUnwrapToWallet)) {
        amount += toNumber(parsed.args.wad, 18);
      }
    } catch {
      // Not a WETH withdrawal event.
    }
  }

  return amount;
}

export function snapshotToAmounts(snapshot: WalletAssetSnapshot | null): WalletAssetAmounts {
  return {
    weth: snapshot?.weth.amount ?? null,
    usdc: snapshot?.usdc.amount ?? null,
    aero: snapshot?.aero.amount ?? null,
    eth: snapshot?.eth.amount ?? null
  };
}

export function amountsToSnapshot(amounts: WalletAssetAmounts, ethPriceUsd: number | null, aeroPriceUsd: number | null): WalletAssetSnapshot {
  const wethValueUsd = valueUsd(amounts.weth, ethPriceUsd);
  const usdcValueUsd = amounts.usdc;
  const aeroValueUsd = valueUsd(amounts.aero, aeroPriceUsd);
  const ethValueUsd = valueUsd(amounts.eth, ethPriceUsd);

  return {
    weth: { symbol: "WETH", amount: amounts.weth, valueUsd: wethValueUsd },
    usdc: { symbol: "USDC", amount: amounts.usdc, valueUsd: usdcValueUsd },
    aero: { symbol: "AERO", amount: amounts.aero, valueUsd: aeroValueUsd },
    eth: { symbol: "ETH", amount: amounts.eth, valueUsd: ethValueUsd },
    totalUsd: sumKnown([wethValueUsd, usdcValueUsd, aeroValueUsd, ethValueUsd]),
    ethPriceUsd,
    aeroPriceUsd
  };
}

export async function getWalletAssetAmountsSnapshot(walletAddress: Address): Promise<WalletAssetAmounts> {
  return getWalletAssetAmountsSnapshotAtBlock(walletAddress);
}

export async function getWalletAssetAmountsSnapshotAtBlock(walletAddress: Address, blockNumber?: bigint): Promise<WalletAssetAmounts> {
  const client = createBaseClient();
  const [ethRaw, wethRaw, usdcRaw, aeroRaw] = await Promise.all([
    client.getBalance({ address: walletAddress, blockNumber }).catch(() => null),
    client
      .readContract({
        address: CONTRACTS.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
        blockNumber
      })
      .catch(() => null),
    client
      .readContract({
        address: CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
        blockNumber
      })
      .catch(() => null),
    client
      .readContract({
        address: CONTRACTS.aero,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress],
        blockNumber
      })
      .catch(() => null)
  ]);

  return {
    eth: ethRaw === null ? null : toNumber(ethRaw, 18),
    weth: wethRaw === null ? null : toNumber(wethRaw, 18),
    usdc: usdcRaw === null ? null : toNumber(usdcRaw, 6),
    aero: aeroRaw === null ? null : toNumber(aeroRaw, 18)
  };
}

export function amountsToPortfolioSnapshot(
  walletAmounts: WalletAssetAmounts,
  lpAmounts: LpAssetAmounts,
  ethPriceUsd: number | null,
  aeroPriceUsd: number | null
): WalletAssetSnapshot {
  const wethValueUsd = valueUsd(walletAmounts.weth, ethPriceUsd);
  const usdcValueUsd = walletAmounts.usdc;
  const aeroValueUsd = valueUsd(walletAmounts.aero, aeroPriceUsd);
  const ethValueUsd = valueUsd(walletAmounts.eth, ethPriceUsd);
  const lpWethValueUsd = valueUsd(lpAmounts.weth, ethPriceUsd);
  const lpUsdcValueUsd = lpAmounts.usdc;

  return {
    weth: { symbol: "WETH", amount: walletAmounts.weth, valueUsd: wethValueUsd },
    usdc: { symbol: "USDC", amount: walletAmounts.usdc, valueUsd: usdcValueUsd },
    aero: { symbol: "AERO", amount: walletAmounts.aero, valueUsd: aeroValueUsd },
    eth: { symbol: "ETH", amount: walletAmounts.eth, valueUsd: ethValueUsd },
    lpWeth: { symbol: "WETH", amount: lpAmounts.weth, valueUsd: lpWethValueUsd },
    lpUsdc: { symbol: "USDC", amount: lpAmounts.usdc, valueUsd: lpUsdcValueUsd },
    totalUsd: sumKnown([wethValueUsd, usdcValueUsd, aeroValueUsd, ethValueUsd, lpWethValueUsd, lpUsdcValueUsd]),
    ethPriceUsd,
    aeroPriceUsd
  };
}

export function subtractDelta(amounts: WalletAssetAmounts, delta: WalletAssetDelta): WalletAssetAmounts {
  return {
    weth: applyValue(amounts.weth, delta.weth),
    usdc: applyValue(amounts.usdc, delta.usdc),
    aero: applyValue(amounts.aero, delta.aero),
    eth: applyValue(amounts.eth, delta.eth)
  };
}

export function subtractLpDelta(amounts: LpAssetAmounts, delta: LpAssetDelta): LpAssetAmounts {
  return {
    weth: applyValue(amounts.weth, delta.weth),
    usdc: applyValue(amounts.usdc, delta.usdc)
  };
}

function addLpValue(value: number | null, delta: number) {
  if (value === null) return null;
  return Math.max(0, value + delta);
}

export function addLpDelta(amounts: LpAssetAmounts, delta: LpAssetDelta): LpAssetAmounts {
  return {
    weth: addLpValue(amounts.weth, delta.weth),
    usdc: addLpValue(amounts.usdc, delta.usdc)
  };
}

export function getTransactionAssetDelta(transaction: TransactionAssetSource, walletAddress: Address): WalletAssetDelta {
  const delta: WalletAssetDelta = { weth: 0, usdc: 0, aero: 0, eth: 0 };
  const tokenAmounts = Array.isArray(transaction.tokenAmounts) ? transaction.tokenAmounts : [];

  for (const item of tokenAmounts) {
    if (!item || typeof item !== "object") continue;
    const amount = item as { symbol?: string; amount?: string; direction?: string };
    const parsed = Number(amount.amount);
    if (!Number.isFinite(parsed)) continue;

    const signed = amount.direction === "out" ? -parsed : parsed;
    if (amount.symbol === "WETH") delta.weth += signed;
    if (amount.symbol === "USDC") delta.usdc += signed;
    if (amount.symbol === "AERO") delta.aero += signed;
  }

  const raw = readRawRecord(transaction.raw);
  const blockscout = readRawRecord(raw.blockscout);
  const receipt = readRawRecord(raw.receipt);
  const wallet = walletAddress.toLowerCase();
  const fromWallet = transaction.fromAddress.toLowerCase() === wallet;
  const toWallet = transaction.toAddress?.toLowerCase() === wallet;
  const nativeValue = rawStringToEth(blockscout.value);

  if (toWallet) delta.eth += nativeValue;
  if (fromWallet) {
    delta.eth -= nativeValue;
    delta.eth -= rawStringToEth(gasCostWei(receipt));
  }
  delta.eth += unwrappedWethAmount(transaction, walletAddress);

  return delta;
}

export function getTransactionLpDelta(transaction: TransactionAssetSource): LpAssetDelta {
  const delta: LpAssetDelta = { weth: 0, usdc: 0 };
  if (!transaction.type?.startsWith("lp_") || transaction.type === "lp_collect") return delta;
  const aerodromeDelta = aerodromeSlipstreamLpDelta(transaction);
  if (aerodromeDelta) return aerodromeDelta;

  const walletDelta = getTransactionAssetDelta(
    {
      ...transaction,
      fromAddress: "",
      toAddress: null,
      raw: {}
    },
    ZERO_ADDRESS
  );

  delta.weth = -walletDelta.weth;
  delta.usdc = -walletDelta.usdc;
  return delta;
}

export function getTransactionPositionLiquidityDeltas(transaction: TransactionAssetSource): PositionLiquidityDelta[] {
  const raw = readRawRecord(transaction.raw);
  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const deltas = new Map<string, bigint>();

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || !record.data || !record.topics) continue;
    const isPositionManager =
      record.address.toLowerCase() === CONTRACTS.nonfungiblePositionManager.toLowerCase() ||
      record.address.toLowerCase() === CONTRACTS.aerodromeNonfungiblePositionManager.toLowerCase();
    if (!isPositionManager) continue;

    try {
      const parsed = decodeEventLog({
        abi: positionManagerAbi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName !== "IncreaseLiquidity" && parsed.eventName !== "DecreaseLiquidity") continue;

      const tokenId = parsed.args.tokenId.toString();
      const signedLiquidity = parsed.eventName === "IncreaseLiquidity" ? parsed.args.liquidity : -parsed.args.liquidity;
      deltas.set(tokenId, (deltas.get(tokenId) ?? 0n) + signedLiquidity);
    } catch {
      // Not a position liquidity event.
    }
  }

  return [...deltas.entries()].map(([tokenId, delta]) => ({ tokenId, delta }));
}

export function getTransactionPositionPrincipalDeltas(
  transaction: TransactionAssetSource,
  positionTokens: Map<string, { token0: string; token1: string }>
): PositionPrincipalDelta[] {
  const raw = readRawRecord(transaction.raw);
  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const deltas = new Map<string, LpAssetDelta>();

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || !record.data || !record.topics) continue;
    const isPositionManager =
      record.address.toLowerCase() === CONTRACTS.nonfungiblePositionManager.toLowerCase() ||
      record.address.toLowerCase() === CONTRACTS.aerodromeNonfungiblePositionManager.toLowerCase();
    if (!isPositionManager) continue;

    try {
      const parsed = decodeEventLog({
        abi: positionManagerAbi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName !== "IncreaseLiquidity" && parsed.eventName !== "DecreaseLiquidity") continue;

      const tokenId = parsed.args.tokenId.toString();
      const tokens = positionTokens.get(tokenId);
      if (!tokens) continue;

      const amounts = lpAmountsFromTokenPair(tokens.token0, tokens.token1, parsed.args.amount0, parsed.args.amount1);
      const sign = parsed.eventName === "IncreaseLiquidity" ? 1 : -1;
      const current = deltas.get(tokenId) ?? { weth: 0, usdc: 0 };
      deltas.set(tokenId, {
        weth: current.weth + sign * (amounts.weth ?? 0),
        usdc: current.usdc + sign * (amounts.usdc ?? 0)
      });
    } catch {
      // Not a position liquidity event.
    }
  }

  return [...deltas.entries()].map(([tokenId, delta]) => ({ tokenId, delta }));
}

export function getNextLpAssetAmounts(amounts: LpAssetAmounts, transaction: TransactionAssetSource): LpAssetAmounts {
  if (transaction.type === "lp_exit") return { weth: 0, usdc: 0 };
  return addLpDelta(amounts, getTransactionLpDelta(transaction));
}

function sqrtRatioAtTick(tick: number) {
  return Math.pow(1.0001, tick / 2);
}

function tokenAmountFromRaw(token: string, rawAmount: number) {
  const meta = TOKEN_META[token.toLowerCase()];
  if (!meta) return 0;
  return rawAmount / 10 ** meta.decimals;
}

function tokenAmountFromRawBigInt(token: string, rawAmount: bigint) {
  const meta = TOKEN_META[token.toLowerCase()];
  if (!meta) return 0;
  return Number(formatUnits(rawAmount, meta.decimals));
}

function absBigInt(value: bigint) {
  return value < 0n ? -value : value;
}

function lpAmountsFromTokenPair(token0: string, token1: string, amount0: bigint, amount1: bigint) {
  const amounts: LpAssetAmounts = { weth: 0, usdc: 0 };
  const token0Amount = tokenAmountFromRawBigInt(token0, amount0);
  const token1Amount = tokenAmountFromRawBigInt(token1, amount1);

  if (token0.toLowerCase() === CONTRACTS.weth.toLowerCase()) amounts.weth = (amounts.weth ?? 0) + token0Amount;
  if (token1.toLowerCase() === CONTRACTS.weth.toLowerCase()) amounts.weth = (amounts.weth ?? 0) + token1Amount;
  if (token0.toLowerCase() === CONTRACTS.usdc.toLowerCase()) amounts.usdc = (amounts.usdc ?? 0) + token0Amount;
  if (token1.toLowerCase() === CONTRACTS.usdc.toLowerCase()) amounts.usdc = (amounts.usdc ?? 0) + token1Amount;

  return amounts;
}

function addKnownLpAmounts(left: LpAssetAmounts, right: LpAssetAmounts): LpAssetAmounts {
  return {
    weth: (left.weth ?? 0) + (right.weth ?? 0),
    usdc: (left.usdc ?? 0) + (right.usdc ?? 0)
  };
}

function subtractKnownLpAmounts(left: LpAssetAmounts, right: LpAssetAmounts): LpAssetAmounts {
  return {
    weth: (left.weth ?? 0) - (right.weth ?? 0),
    usdc: (left.usdc ?? 0) - (right.usdc ?? 0)
  };
}

export function getTransactionPositionExitAmounts(transaction: TransactionAssetSource, tokenId: string, token0: string, token1: string) {
  const raw = readRawRecord(transaction.raw);
  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  let principal: LpAssetAmounts = { weth: 0, usdc: 0 };
  let collected: LpAssetAmounts = { weth: 0, usdc: 0 };
  let sawExitEvent = false;

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || !record.data || !record.topics) continue;
    const isPositionManager =
      record.address.toLowerCase() === CONTRACTS.nonfungiblePositionManager.toLowerCase() ||
      record.address.toLowerCase() === CONTRACTS.aerodromeNonfungiblePositionManager.toLowerCase();
    if (!isPositionManager) continue;

    try {
      const parsed = decodeEventLog({
        abi: positionManagerAbi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName !== "DecreaseLiquidity" && parsed.eventName !== "Collect") continue;
      if (parsed.args.tokenId.toString() !== tokenId) continue;

      const amounts = lpAmountsFromTokenPair(token0, token1, parsed.args.amount0, parsed.args.amount1);
      if (parsed.eventName === "DecreaseLiquidity") principal = addKnownLpAmounts(principal, amounts);
      if (parsed.eventName === "Collect") collected = addKnownLpAmounts(collected, amounts);
      sawExitEvent = true;
    } catch {
      // Not a position-manager exit event.
    }
  }

  if (!sawExitEvent) return null;

  return {
    principal,
    collected,
    earned: subtractKnownLpAmounts(collected, principal)
  } satisfies PositionExitAmounts;
}

function getSupportedTokenTransfers(logs: unknown[]): TokenTransfer[] {
  const transfers: TokenTransfer[] = [];

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || !record.data || !record.topics) continue;
    const token = record.address.toLowerCase();
    if (token !== CONTRACTS.weth.toLowerCase() && token !== CONTRACTS.usdc.toLowerCase()) continue;

    try {
      const parsed = decodeEventLog({
        abi: erc20Abi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName !== "Transfer") continue;
      const symbol = token === CONTRACTS.weth.toLowerCase() ? "WETH" : "USDC";
      transfers.push({
        token,
        symbol,
        from: parsed.args.from.toLowerCase(),
        to: parsed.args.to.toLowerCase(),
        amount: Number(formatUnits(parsed.args.value, symbol === "WETH" ? 18 : 6))
      });
    } catch {
      // Not an ERC-20 transfer event.
    }
  }

  return transfers;
}

function sumTransfers(transfers: TokenTransfer[], params: { symbol: "WETH" | "USDC"; from: string; to: string }) {
  return transfers.reduce((sum, transfer) => {
    if (transfer.symbol !== params.symbol || transfer.from !== params.from || transfer.to !== params.to) return sum;
    return sum + transfer.amount;
  }, 0);
}

function getSettlementDirectionalSwaps(transaction: { raw?: unknown; fromAddress?: string; toAddress?: string | null }) {
  const raw = readRawRecord(transaction.raw);
  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const transfers = getSupportedTokenTransfers(logs);
  const participants = [transaction.fromAddress, transaction.toAddress]
    .filter((address): address is string => Boolean(address))
    .map((address) => address.toLowerCase())
    .filter((address, index, addresses) => addresses.indexOf(address) === index && !SWAP_SETTLEMENT_TARGETS.includes(address));
  const swaps: TransactionDirectionalSwap[] = [];

  for (const participant of participants) {
    for (const target of SWAP_SETTLEMENT_TARGETS) {
      const wethOut = sumTransfers(transfers, { symbol: "WETH", from: participant, to: target });
      const wethIn = sumTransfers(transfers, { symbol: "WETH", from: target, to: participant });
      const usdcOut = sumTransfers(transfers, { symbol: "USDC", from: participant, to: target });
      const usdcIn = sumTransfers(transfers, { symbol: "USDC", from: target, to: participant });

      if (wethOut > 0 && usdcIn > 0) {
        swaps.push({
          side: "sell_weth",
          wethAmount: wethOut,
          usdcAmount: usdcIn,
          effectivePrice: usdcIn / wethOut,
          poolAddress: target,
          tick: 0
        });
      }
      if (usdcOut > 0 && wethIn > 0) {
        swaps.push({
          side: "buy_weth",
          wethAmount: wethIn,
          usdcAmount: usdcOut,
          effectivePrice: usdcOut / wethIn,
          poolAddress: target,
          tick: 0
        });
      }
    }
  }

  return swaps;
}

export function getTransactionDirectionalSwaps(transaction: { raw?: unknown; fromAddress?: string; toAddress?: string | null }): TransactionDirectionalSwap[] {
  const raw = readRawRecord(transaction.raw);
  const receipt = readRawRecord(raw.receipt);
  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  const settlementSwaps = getSettlementDirectionalSwaps(transaction);
  if (settlementSwaps.length > 0) return settlementSwaps;
  const swaps: TransactionDirectionalSwap[] = [];

  for (const log of logs) {
    if (!log || typeof log !== "object") continue;
    const record = log as { address?: string; data?: `0x${string}`; topics?: [`0x${string}`, ...`0x${string}`[]] };
    if (!record.address || !record.data || !record.topics) continue;
    if (!WETH_USDC_UNISWAP_V3_POOL_SET.has(record.address.toLowerCase())) continue;

    try {
      const parsed = decodeEventLog({
        abi: poolAbi,
        data: record.data,
        topics: record.topics
      });
      if (parsed.eventName !== "Swap") continue;

      const wethRaw = parsed.args.amount0;
      const usdcRaw = parsed.args.amount1;
      const soldWeth = wethRaw > 0n && usdcRaw < 0n;
      const boughtWeth = wethRaw < 0n && usdcRaw > 0n;
      if (!soldWeth && !boughtWeth) continue;

      const wethAmount = Number(formatUnits(absBigInt(wethRaw), 18));
      const usdcAmount = Number(formatUnits(absBigInt(usdcRaw), 6));
      if (wethAmount <= 0 || usdcAmount <= 0) continue;

      swaps.push({
        side: soldWeth ? "sell_weth" : "buy_weth",
        wethAmount,
        usdcAmount,
        effectivePrice: usdcAmount / wethAmount,
        poolAddress: record.address,
        tick: Number(parsed.args.tick)
      });
    } catch {
      // Not a Uniswap v3 pool swap event.
    }
  }

  return swaps;
}

function priceFromTick(params: { tick: number; token0: Address; token1: Address; baseToken: Address; quoteToken: Address }) {
  const token0Meta = TOKEN_META[params.token0.toLowerCase()];
  const token1Meta = TOKEN_META[params.token1.toLowerCase()];
  if (!token0Meta || !token1Meta) return null;

  const token1PerToken0 = Math.pow(1.0001, params.tick) * 10 ** (token0Meta.decimals - token1Meta.decimals);
  const token0 = params.token0.toLowerCase();
  const token1 = params.token1.toLowerCase();
  const base = params.baseToken.toLowerCase();
  const quote = params.quoteToken.toLowerCase();

  if (token0 === base && token1 === quote) return token1PerToken0;
  if (token0 === quote && token1 === base) return 1 / token1PerToken0;
  return null;
}

export function executableWethSellPrice(priceUsd: number, fee: number) {
  return priceUsd * (1 - fee / 1_000_000);
}

function getPoolTokens(address: Address, abi: typeof poolAbi | typeof slipstreamPoolAbi) {
  const key = address.toLowerCase();
  let cached = poolTokenCache.get(key);
  if (!cached) {
    const client = createBaseClient();
    cached = Promise.all([
      client.readContract({ address, abi, functionName: "token0" }),
      client.readContract({ address, abi, functionName: "token1" })
    ]).then(([token0, token1]) => ({ token0, token1 }));
    poolTokenCache.set(key, cached);
  }
  return cached;
}

function getCachedHistoricalPrice(key: string, load: () => Promise<number | null>) {
  let cached = historicalPriceCache.get(key);
  if (!cached) {
    cached = load().catch(() => null);
    historicalPriceCache.set(key, cached);
  }
  return cached;
}

export function getPositionLpAssetAmounts(position: PositionAssetSource): LpAssetAmounts {
  const lpAmounts = { weth: 0, usdc: 0 };
  const liquidity = Number(position.liquidity);
  if (!Number.isFinite(liquidity) || liquidity <= 0 || position.currentTick === null) return lpAmounts;

  const sqrtLower = sqrtRatioAtTick(position.tickLower);
  const sqrtUpper = sqrtRatioAtTick(position.tickUpper);
  const sqrtCurrent = sqrtRatioAtTick(Math.min(Math.max(position.currentTick, position.tickLower), position.tickUpper));
  const token0Raw = position.currentTick < position.tickUpper ? liquidity * ((sqrtUpper - sqrtCurrent) / (sqrtCurrent * sqrtUpper)) : 0;
  const token1Raw = position.currentTick > position.tickLower ? liquidity * (sqrtCurrent - sqrtLower) : 0;

  const token0Amount = tokenAmountFromRaw(position.token0, token0Raw);
  const token1Amount = tokenAmountFromRaw(position.token1, token1Raw);

  if (position.token0.toLowerCase() === CONTRACTS.weth.toLowerCase()) lpAmounts.weth += token0Amount;
  if (position.token1.toLowerCase() === CONTRACTS.weth.toLowerCase()) lpAmounts.weth += token1Amount;
  if (position.token0.toLowerCase() === CONTRACTS.usdc.toLowerCase()) lpAmounts.usdc += token0Amount;
  if (position.token1.toLowerCase() === CONTRACTS.usdc.toLowerCase()) lpAmounts.usdc += token1Amount;

  return lpAmounts;
}

export function getCurrentLpAssetAmounts(positions: PositionAssetSource[]): LpAssetAmounts {
  const lpAmounts = { weth: 0, usdc: 0 };

  for (const position of positions) {
    const positionAmounts = getPositionLpAssetAmounts(position);
    lpAmounts.weth += positionAmounts.weth ?? 0;
    lpAmounts.usdc += positionAmounts.usdc ?? 0;
  }

  return lpAmounts;
}

export async function getEthPriceUsd() {
  return getBestExecutableWethUsdcSellPrice();
}

async function getBestExecutableWethUsdcSellPrice(blockNumber?: bigint) {
  const client = createBaseClient();
  const pools = await Promise.all(
    WETH_USDC_FEE_TIERS.map(async (fee) => ({
      fee,
      address: await client.readContract({
        address: CONTRACTS.uniswapV3Factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [CONTRACTS.weth, CONTRACTS.usdc, fee],
        blockNumber
      })
    }))
  );

  const activePools = await Promise.all(
    pools
      .filter((pool) => pool.address !== ZERO_ADDRESS)
      .map(async (pool) => {
        const [slot0, liquidity, token0, token1] = await Promise.all([
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "slot0", blockNumber }),
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "liquidity", blockNumber }),
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "token0", blockNumber }),
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "token1", blockNumber })
        ]);
        return { ...pool, slot0, liquidity, token0, token1 };
      })
  );

  const selected = activePools.reduce<((typeof activePools)[number] & { executableSellPrice: number }) | null>((best, pool) => {
    const tick = Number(pool.slot0[1]);
    const price = priceFromTick({ tick, token0: pool.token0, token1: pool.token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
    if (price === null) return best;

    const executableSellPrice = executableWethSellPrice(price, pool.fee);
    if (!best || executableSellPrice > best.executableSellPrice) return { ...pool, executableSellPrice };
    return best;
  }, null);

  if (!selected || selected.liquidity === 0n) return null;

  return selected.executableSellPrice;
}

export async function getEthPriceUsdAtBlock(blockNumber: bigint) {
  return getCachedHistoricalPrice(`eth:${blockNumber.toString()}`, () => getBestExecutableWethUsdcSellPrice(blockNumber));
}

async function getAeroPriceUsd() {
  const client = createBaseClient();
  const [slot0, liquidity, token0, token1] = await Promise.all([
    client.readContract({ address: CONTRACTS.aeroUsdcSlipstreamPool, abi: slipstreamPoolAbi, functionName: "slot0" }),
    client.readContract({ address: CONTRACTS.aeroUsdcSlipstreamPool, abi: slipstreamPoolAbi, functionName: "liquidity" }),
    client.readContract({ address: CONTRACTS.aeroUsdcSlipstreamPool, abi: slipstreamPoolAbi, functionName: "token0" }),
    client.readContract({ address: CONTRACTS.aeroUsdcSlipstreamPool, abi: slipstreamPoolAbi, functionName: "token1" })
  ]);

  if (liquidity === 0n) return null;
  return priceFromTick({ tick: Number(slot0[1]), token0, token1, baseToken: CONTRACTS.aero, quoteToken: CONTRACTS.usdc });
}

export async function getAeroPriceUsdAtBlock(blockNumber: bigint) {
  return getCachedHistoricalPrice(`aero:${blockNumber.toString()}`, async () => {
    const client = createBaseClient();
    const [slot0, liquidity, tokens] = await Promise.all([
      client.readContract({ address: CONTRACTS.aeroUsdcSlipstreamPool, abi: slipstreamPoolAbi, functionName: "slot0", blockNumber }),
      client.readContract({ address: CONTRACTS.aeroUsdcSlipstreamPool, abi: slipstreamPoolAbi, functionName: "liquidity", blockNumber }),
      getPoolTokens(CONTRACTS.aeroUsdcSlipstreamPool, slipstreamPoolAbi)
    ]);

    if (liquidity === 0n) return null;
    return priceFromTick({ tick: Number(slot0[1]), token0: tokens.token0, token1: tokens.token1, baseToken: CONTRACTS.aero, quoteToken: CONTRACTS.usdc });
  });
}

export async function getWalletAssetSnapshot(walletAddress: Address): Promise<WalletAssetSnapshot> {
  const client = createBaseClient();
  const [ethPriceUsd, aeroPriceUsd, ethRaw, wethRaw, usdcRaw, aeroRaw] = await Promise.all([
    getEthPriceUsd().catch(() => null),
    getAeroPriceUsd().catch(() => null),
    client.getBalance({ address: walletAddress }).catch(() => null),
    client
      .readContract({
        address: CONTRACTS.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress]
      })
      .catch(() => null),
    client
      .readContract({
        address: CONTRACTS.usdc,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress]
      })
      .catch(() => null),
    client
      .readContract({
        address: CONTRACTS.aero,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [walletAddress]
      })
      .catch(() => null)
  ]);

  const ethAmount = ethRaw === null ? null : toNumber(ethRaw, 18);
  const wethAmount = wethRaw === null ? null : toNumber(wethRaw, 18);
  const usdcAmount = usdcRaw === null ? null : toNumber(usdcRaw, 6);
  const aeroAmount = aeroRaw === null ? null : toNumber(aeroRaw, 18);
  const ethValueUsd = valueUsd(ethAmount, ethPriceUsd);
  const wethValueUsd = valueUsd(wethAmount, ethPriceUsd);
  const usdcValueUsd = usdcAmount;
  const aeroValueUsd = valueUsd(aeroAmount, aeroPriceUsd);

  return {
    weth: { symbol: "WETH", amount: wethAmount, valueUsd: wethValueUsd },
    usdc: { symbol: "USDC", amount: usdcAmount, valueUsd: usdcValueUsd },
    aero: { symbol: "AERO", amount: aeroAmount, valueUsd: aeroValueUsd },
    eth: { symbol: "ETH", amount: ethAmount, valueUsd: ethValueUsd },
    totalUsd: sumKnown([wethValueUsd, usdcValueUsd, aeroValueUsd, ethValueUsd]),
    ethPriceUsd,
    aeroPriceUsd
  };
}
