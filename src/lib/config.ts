import { z } from "zod";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const WEAK_APP_PASSWORDS = new Set(["change-me", "change-me-now", "password", "walletbot", "replace-with-long-random-password"]);

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  BASE_WALLET_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  BASE_RPC_URL: z.string().url(),
  BASE_RPC_ADD_URLS: z.string().optional().default(""),
  AUTOPILOT_PRESET: z.enum(["triple_range", "small_capital_test"]).optional().default("triple_range"),
  AUTOPILOT_MODE: z.enum(["manual", "approve_in_telegram", "auto_guarded", "auto_full"]).optional().default("approve_in_telegram"),
  AUTOPILOT_SWAP_PROVIDER: z
    .enum(["uniswap_v3", "llamaswap", "zeroex", "odos", "kyber", "paraswap"])
    .optional()
    .default("odos"),
  AUTOPILOT_SWAP_SLIPPAGE_BPS: z.coerce.number().int().min(0).max(10_000).optional().default(50),
  AUTOPILOT_MAX_GAS_COST_USD: z.coerce.number().min(0).optional().default(0.5),
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
  AUTOPILOT_PRICE_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).default(1000),
  AUTOPILOT_PRICE_WATCH_MIN_BREAKOUT_TICKS: z.coerce.number().int().min(0).default(5),
  AUTOPILOT_AUTO_RETRY_DEDUPE_MS: z.coerce.number().int().min(0).default(300_000),
  AUTOPILOT_TOP_UP_ENABLED: z
    .string()
    .optional()
    .default("true")
    .transform((value) => value !== "false" && value !== "0"),
  AUTOPILOT_TOP_UP_MIN_USD: z.coerce.number().min(0).optional().default(10),
  AUTOPILOT_TOP_UP_COOLDOWN_HOURS: z.coerce.number().min(1).optional().default(24),
  AUTOPILOT_TOP_UP_WATCH_INTERVAL_MS: z.coerce.number().int().min(0).optional().default(30_000),
  AUTOPILOT_TOP_UP_MIN_EFFICIENCY_BPS: z.coerce.number().int().min(0).max(10_000).optional().default(8_500),
  AUTOPILOT_TOP_UP_MIN_BOUNDARY_DISTANCE_TICKS: z.coerce.number().int().min(0).optional().default(10),
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
    .default(""),
  ODOS_API_KEY: z
    .string()
    .optional()
    .default(""),
  ODOS_API_BASE_URL: z
    .string()
    .url()
    .optional()
    .default("https://api.odos.xyz")
}).superRefine((env, ctx) => {
  if (env.TELEGRAM_BOT_TOKEN && !env.TELEGRAM_CHAT_ID) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["TELEGRAM_CHAT_ID"],
      message: "TELEGRAM_CHAT_ID is required when TELEGRAM_BOT_TOKEN is configured."
    });
  }

  if (process.env.NODE_ENV === "production" && WEAK_APP_PASSWORDS.has(env.APP_PASSWORD.toLowerCase())) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["APP_PASSWORD"],
      message: "APP_PASSWORD must be set to a non-default value in production."
    });
  }
});

let cachedConfig: z.infer<typeof envSchema> | undefined;

export function getConfig() {
  if (!cachedConfig) {
    cachedConfig = envSchema.parse(process.env);
  }

  return cachedConfig;
}
