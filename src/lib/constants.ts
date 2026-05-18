import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

export const CONTRACTS = {
  uniswapV3Factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  nonfungiblePositionManager: "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1",
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

export const EXPLORER_TX_URL = "https://basescan.org/tx/";
