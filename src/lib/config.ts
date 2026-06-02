import { z } from "zod";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BASE_WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  BASE_RPC_URL: z.string().url(),
  BASE_RPC_ADD_URLS: z.string().optional().default(""),
  AUTOPILOT_PRESET: z.enum(["triple_range", "small_capital_test"]).optional().default("triple_range"),
  AUTOPILOT_SWAP_PROVIDER: z
    .enum(["uniswap_v3", "llamaswap", "zeroex", "odos", "kyber", "paraswap"])
    .optional()
    .default("uniswap_v3"),
  AUTOPILOT_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).optional().default(100),
  AUTOPILOT_BASELINE_AT: z
    .string()
    .datetime()
    .optional()
    .default(""),
  AUTOPILOT_REBALANCER_ADDRESS: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{40}$/)])
    .optional()
    .default(""),
  AUTOPILOT_EXECUTOR_ADDRESS: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{40}$/)])
    .optional()
    .default(""),
  BLOCKSCOUT_BASE_URL: z.string().url().default("https://base.blockscout.com"),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(""),
  TELEGRAM_CHAT_ID: z.string().optional().default(""),
  WEB_APP_URL: z.union([z.literal(""), z.string().url()]).optional().default(""),
  APP_PASSWORD: z.string().min(8).default("change-me-now"),
  SYNC_INTERVAL_SECONDS: z.coerce.number().int().min(30).default(180),
  NEXT_PUBLIC_APP_NAME: z.string().default("WalletBot"),
  AUTOPILOT_LIVE_EXECUTION_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true" || value === "1"),
  BASE_WALLET_PRIVATE_KEY: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{64}$/)])
    .optional()
    .default(""),
  AUTOPILOT_EXECUTOR_PRIVATE_KEY: z
    .union([z.literal(""), z.string().regex(/^0x[a-fA-F0-9]{64}$/)])
    .optional()
    .default(""),
  ZEROX_API_KEY: z
    .string()
    .optional()
    .default("")
});

let cachedConfig: z.infer<typeof envSchema> | undefined;

export function getConfig() {
  if (!cachedConfig) {
    cachedConfig = envSchema.parse(process.env);
  }

  return cachedConfig;
}
