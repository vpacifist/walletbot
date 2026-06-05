import { formatUnits, getAddress } from "viem";
import { CONTRACTS, TOKEN_META } from "./constants";

const Q32 = 2n ** 32n;
const Q96 = 2n ** 96n;
const MIN_TICK = -887272;
const MAX_TICK = 887272;

function mulShift(value: bigint, multiplier: bigint) {
  return (value * multiplier) >> 128n;
}

export function getSqrtRatioAtTick(tick: number) {
  if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`Tick out of range: ${tick}`);

  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 0x1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;

  if ((absTick & 0x2) !== 0) ratio = mulShift(ratio, 0xfff97272373d413259a46990580e213an);
  if ((absTick & 0x4) !== 0) ratio = mulShift(ratio, 0xfff2e50f5f656932ef12357cf3c7fdccn);
  if ((absTick & 0x8) !== 0) ratio = mulShift(ratio, 0xffe5caca7e10e4e61c3624eaa0941cd0n);
  if ((absTick & 0x10) !== 0) ratio = mulShift(ratio, 0xffcb9843d60f6159c9db58835c926644n);
  if ((absTick & 0x20) !== 0) ratio = mulShift(ratio, 0xff973b41fa98c081472e6896dfb254c0n);
  if ((absTick & 0x40) !== 0) ratio = mulShift(ratio, 0xff2ea16466c96a3843ec78b326b52861n);
  if ((absTick & 0x80) !== 0) ratio = mulShift(ratio, 0xfe5dee046a99a2a811c461f1969c3053n);
  if ((absTick & 0x100) !== 0) ratio = mulShift(ratio, 0xfcbe86c7900a88aedcffc83b479aa3a4n);
  if ((absTick & 0x200) !== 0) ratio = mulShift(ratio, 0xf987a7253ac413176f2b074cf7815e54n);
  if ((absTick & 0x400) !== 0) ratio = mulShift(ratio, 0xf3392b0822b70005940c7a398e4b70f3n);
  if ((absTick & 0x800) !== 0) ratio = mulShift(ratio, 0xe7159475a2c29b7443b29c7fa6e889d9n);
  if ((absTick & 0x1000) !== 0) ratio = mulShift(ratio, 0xd097f3bdfd2022b8845ad8f792aa5825n);
  if ((absTick & 0x2000) !== 0) ratio = mulShift(ratio, 0xa9f746462d870fdf8a65dc1f90e061e5n);
  if ((absTick & 0x4000) !== 0) ratio = mulShift(ratio, 0x70d869a156d2a1b890bb3df62baf32f7n);
  if ((absTick & 0x8000) !== 0) ratio = mulShift(ratio, 0x31be135f97d08fd981231505542fcfa6n);
  if ((absTick & 0x10000) !== 0) ratio = mulShift(ratio, 0x9aa508b5b7a84e1c677de54f3e99bc9n);
  if ((absTick & 0x20000) !== 0) ratio = mulShift(ratio, 0x5d6af8dedb81196699c329225ee604n);
  if ((absTick & 0x40000) !== 0) ratio = mulShift(ratio, 0x2216e584f5fa1ea926041bedfe98n);
  if ((absTick & 0x80000) !== 0) ratio = mulShift(ratio, 0x48a170391f7dc42444e8fa2n);

  if (tick > 0) ratio = ((1n << 256n) - 1n) / ratio;

  return ratio / Q32 + (ratio % Q32 === 0n ? 0n : 1n);
}

function divRoundingUp(numerator: bigint, denominator: bigint) {
  return numerator / denominator + (numerator % denominator === 0n ? 0n : 1n);
}

export function getAmount0Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint) {
  const [sqrtA, sqrtB] =
    sqrtRatioAX96 > sqrtRatioBX96 ? [sqrtRatioBX96, sqrtRatioAX96] : [sqrtRatioAX96, sqrtRatioBX96];
  const numerator = liquidity * Q96 * (sqrtB - sqrtA);
  return divRoundingUp(divRoundingUp(numerator, sqrtB), sqrtA);
}

export function getAmount1Delta(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, liquidity: bigint) {
  const [sqrtA, sqrtB] =
    sqrtRatioAX96 > sqrtRatioBX96 ? [sqrtRatioBX96, sqrtRatioAX96] : [sqrtRatioAX96, sqrtRatioBX96];
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

function getLiquidityForAmount0(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, amount0: bigint) {
  const [sqrtA, sqrtB] =
    sqrtRatioAX96 > sqrtRatioBX96 ? [sqrtRatioBX96, sqrtRatioAX96] : [sqrtRatioAX96, sqrtRatioBX96];
  const intermediate = (sqrtA * sqrtB) / Q96;
  return (amount0 * intermediate) / (sqrtB - sqrtA);
}

function getLiquidityForAmount1(sqrtRatioAX96: bigint, sqrtRatioBX96: bigint, amount1: bigint) {
  const [sqrtA, sqrtB] =
    sqrtRatioAX96 > sqrtRatioBX96 ? [sqrtRatioBX96, sqrtRatioAX96] : [sqrtRatioAX96, sqrtRatioBX96];
  return (amount1 * Q96) / (sqrtB - sqrtA);
}

export function getLiquidityForAmounts(input: {
  amount0: bigint;
  amount1: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
}) {
  const sqrtCurrent = getSqrtRatioAtTick(input.currentTick);
  const sqrtLower = getSqrtRatioAtTick(input.tickLower);
  const sqrtUpper = getSqrtRatioAtTick(input.tickUpper);

  if (input.currentTick < input.tickLower) {
    return getLiquidityForAmount0(sqrtLower, sqrtUpper, input.amount0);
  }
  if (input.currentTick < input.tickUpper) {
    const liquidity0 = getLiquidityForAmount0(sqrtCurrent, sqrtUpper, input.amount0);
    const liquidity1 = getLiquidityForAmount1(sqrtLower, sqrtCurrent, input.amount1);
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return getLiquidityForAmount1(sqrtLower, sqrtUpper, input.amount1);
}

export function getTokenAmountsForLiquidity(input: {
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
}) {
  const sqrtCurrent = getSqrtRatioAtTick(input.currentTick);
  const sqrtLower = getSqrtRatioAtTick(input.tickLower);
  const sqrtUpper = getSqrtRatioAtTick(input.tickUpper);

  if (input.currentTick < input.tickLower) {
    return {
      amount0: getAmount0Delta(sqrtLower, sqrtUpper, input.liquidity),
      amount1: 0n
    };
  }
  if (input.currentTick < input.tickUpper) {
    return {
      amount0: getAmount0Delta(sqrtCurrent, sqrtUpper, input.liquidity),
      amount1: getAmount1Delta(sqrtLower, sqrtCurrent, input.liquidity)
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1Delta(sqrtLower, sqrtUpper, input.liquidity)
  };
}

export function getPositionTokenAmounts(input: {
  token0: string;
  token1: string;
  liquidity: bigint;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
}) {
  const sqrtCurrent = getSqrtRatioAtTick(input.currentTick);
  const sqrtLower = getSqrtRatioAtTick(input.tickLower);
  const sqrtUpper = getSqrtRatioAtTick(input.tickUpper);

  let amount0 = 0n;
  let amount1 = 0n;

  if (input.currentTick < input.tickLower) {
    amount0 = getAmount0Delta(sqrtLower, sqrtUpper, input.liquidity);
  } else if (input.currentTick < input.tickUpper) {
    amount0 = getAmount0Delta(sqrtCurrent, sqrtUpper, input.liquidity);
    amount1 = getAmount1Delta(sqrtLower, sqrtCurrent, input.liquidity);
  } else {
    amount1 = getAmount1Delta(sqrtLower, sqrtUpper, input.liquidity);
  }

  const token0 = getAddress(input.token0);
  const token1 = getAddress(input.token1);
  const wethAddress = getAddress(CONTRACTS.weth);
  const usdcAddress = getAddress(CONTRACTS.usdc);

  return {
    weth:
      token0 === wethAddress
        ? formatUnits(amount0, TOKEN_META[CONTRACTS.weth.toLowerCase()].decimals)
        : token1 === wethAddress
          ? formatUnits(amount1, TOKEN_META[CONTRACTS.weth.toLowerCase()].decimals)
          : null,
    usdc:
      token0 === usdcAddress
        ? formatUnits(amount0, TOKEN_META[CONTRACTS.usdc.toLowerCase()].decimals)
        : token1 === usdcAddress
          ? formatUnits(amount1, TOKEN_META[CONTRACTS.usdc.toLowerCase()].decimals)
          : null
  };
}

export function tickToWethUsdcPrice(tick: number, token0: string, token1: string) {
  const token0Decimals = TOKEN_META[token0.toLowerCase()]?.decimals;
  const token1Decimals = TOKEN_META[token1.toLowerCase()]?.decimals;
  if (token0Decimals === undefined || token1Decimals === undefined) return null;

  const token1PerToken0 = 1.0001 ** tick * 10 ** (token0Decimals - token1Decimals);
  if (getAddress(token0) === getAddress(CONTRACTS.weth) && getAddress(token1) === getAddress(CONTRACTS.usdc)) {
    return token1PerToken0;
  }
  if (getAddress(token0) === getAddress(CONTRACTS.usdc) && getAddress(token1) === getAddress(CONTRACTS.weth)) {
    return 1 / token1PerToken0;
  }
  return null;
}
