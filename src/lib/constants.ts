import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

export const CONTRACTS = {
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  uniswapV3QuoterV2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  uniswapV3SwapRouter02: "0x2626664c2603336E57B271c5C0b26F421741e481",
  nonfungiblePositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  aerodromeNonfungiblePositionManager: "0x827922686190790b37229fd06084350E74485b72",
  nftFarmStrategy: "0xD62b33A7Df4D0ca5EdD373576E48F73366E36179",
  aerodromeNftFarmStrategy: "0x9699bE38E6D54E51a4b36645726FEE9CC736EB45",
  aeroUsdcSlipstreamPool: "0xBE00fF35AF70E8415D0eB605a286D8A45466A4c1",
  zeroExAllowanceHolder: "0x0000000000001fF3684f28c67538d4D072C22734",
  zeroExSettler: "0x7747F8D2a76BD6345Cc29622a946A929647F2359",
  kyberSwapMetaAggregationRouterV2: "0x6131B5fae19EA4f9D964eAc0408E4408b66337b5",
  odosSmartOrderRouterV3: "0x0D05a7D3448512B78fa8A9e46c4872C88C4a0D05",
  veloraAugustusV6: "0x6A000F20005980200259B80c5102003040001068",
  wethUsdcUniswapV3Pool: "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  wethUsdcUniswapV3Pool3000: "0x6c561B446416E1A00E8E93E221854d6eA4171372",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  aero: "0x940181a94A35A4569E4529A3CDfB74e38FD98631"
} as const satisfies Record<string, Address>;

export const WETH_USDC_UNISWAP_V3_POOL_ADDRESSES = [
  "0xb4CB800910B228ED3d0834cF79D697127BBB00e5",
  "0xd0b53D9277642d899DF5C87A3966A349A798F224",
  "0x6c561B446416E1A00E8E93E221854d6eA4171372",
  "0x0b1C2DCbBfA744ebD3fC17fF1A96A1E1Eb4B2d69"
] as const satisfies readonly Address[];

export const WETH_USDC_UNISWAP_V3_POOL_SET = new Set(WETH_USDC_UNISWAP_V3_POOL_ADDRESSES.map((address) => address.toLowerCase()));

export const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  [CONTRACTS.weth.toLowerCase()]: { symbol: "WETH", decimals: 18 },
  [CONTRACTS.usdc.toLowerCase()]: { symbol: "USDC", decimals: 6 },
  [CONTRACTS.aero.toLowerCase()]: { symbol: "AERO", decimals: 18 }
};

export const SUPPORTED_TOKEN_SET = new Set([
  CONTRACTS.weth.toLowerCase(),
  CONTRACTS.usdc.toLowerCase(),
  CONTRACTS.aero.toLowerCase()
]);

export const WETH_USDC_FEE_TIERS = [100, 500, 3000, 10000] as const;

export const EXPLORER_TX_URL = "https://basescan.org/tx/";
