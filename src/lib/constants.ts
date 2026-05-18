import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

export const CONTRACTS = {
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  nonfungiblePositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
  aerodromeNonfungiblePositionManager: "0x827922686190790b37229fd06084350E74485b72",
  nftFarmStrategy: "0xD62b33A7Df4D0ca5EdD373576E48F73366E36179",
  aerodromeNftFarmStrategy: "0x9699bE38E6D54E51a4b36645726FEE9CC736EB45",
  zeroExAllowanceHolder: "0x0000000000001fF3684f28c67538d4D072C22734",
  weth: "0x4200000000000000000000000000000000000006",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
} as const satisfies Record<string, Address>;

export const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  [CONTRACTS.weth.toLowerCase()]: { symbol: "WETH", decimals: 18 },
  [CONTRACTS.usdc.toLowerCase()]: { symbol: "USDC", decimals: 6 }
};

export const SUPPORTED_TOKEN_SET = new Set([
  CONTRACTS.weth.toLowerCase(),
  CONTRACTS.usdc.toLowerCase()
]);

export const WETH_USDC_FEE_TIERS = [500, 3000, 10000] as const;

export const EXPLORER_TX_URL = "https://basescan.org/tx/";
