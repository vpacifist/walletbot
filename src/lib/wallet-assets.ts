import { decodeEventLog, formatUnits, type Address } from "viem";
import { erc20Abi, factoryAbi, poolAbi, positionManagerAbi, slipstreamPoolAbi } from "./abi";
import { createBaseClient } from "./chain";
import { CONTRACTS, TOKEN_META, WETH_USDC_FEE_TIERS } from "./constants";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;

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
  return value === null ? null : value - delta;
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
  if (transaction.type !== "lp_increase" || !isAerodromeStrategy) return null;

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

export function getCurrentLpAssetAmounts(positions: PositionAssetSource[]): LpAssetAmounts {
  const lpAmounts = { weth: 0, usdc: 0 };

  for (const position of positions) {
    const liquidity = Number(position.liquidity);
    if (!Number.isFinite(liquidity) || liquidity <= 0 || position.currentTick === null) continue;

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
  }

  return lpAmounts;
}

async function getEthPriceUsd() {
  const client = createBaseClient();
  const pools = await Promise.all(
    WETH_USDC_FEE_TIERS.map(async (fee) => ({
      fee,
      address: await client.readContract({
        address: CONTRACTS.uniswapV3Factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [CONTRACTS.weth, CONTRACTS.usdc, fee]
      })
    }))
  );

  const activePools = await Promise.all(
    pools
      .filter((pool) => pool.address !== ZERO_ADDRESS)
      .map(async (pool) => {
        const [slot0, liquidity, token0, token1] = await Promise.all([
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "slot0" }),
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "liquidity" }),
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "token0" }),
          client.readContract({ address: pool.address, abi: poolAbi, functionName: "token1" })
        ]);
        return { ...pool, slot0, liquidity, token0, token1 };
      })
  );

  const selected = activePools.reduce<(typeof activePools)[number] | null>((best, pool) => {
    if (!best || pool.liquidity > best.liquidity) return pool;
    return best;
  }, null);

  if (!selected || selected.liquidity === 0n) return null;

  const tick = Number(selected.slot0[1]);
  return priceFromTick({ tick, token0: selected.token0, token1: selected.token1, baseToken: CONTRACTS.weth, quoteToken: CONTRACTS.usdc });
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
