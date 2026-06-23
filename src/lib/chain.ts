import { createPublicClient, createWalletClient, fallback, http, webSocket } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getConfig } from "./config";

export const PUBLIC_BASE_RPC_URLS = ["https://mainnet.base.org", "https://base-rpc.publicnode.com", "https://base.drpc.org"] as const;

export function baseRpcUrls() {
  const config = getConfig();
  const extraUrls = config.BASE_RPC_ADD_URLS.split(/[\s,;]+/).filter(Boolean);
  return [...new Set([config.BASE_RPC_URL, ...extraUrls])];
}

export function baseRpcUrlsWithPublicFallback() {
  return [...new Set([...baseRpcUrls(), ...PUBLIC_BASE_RPC_URLS])];
}

export function createBaseClientForUrl(url: string) {
  return createPublicClient({
    chain: base,
    transport: http(url, {
      retryCount: 2,
      timeout: 15_000
    })
  });
}

function baseTransport() {
  const transports = baseRpcUrlsWithPublicFallback().map((url) =>
    http(url, {
      retryCount: 3,
      timeout: 15_000
    })
  );

  return transports.length === 1
    ? transports[0]
    : fallback(transports, {
        rank: false,
        retryCount: 1
      });
}

export function createBaseClient() {
  return createPublicClient({
    chain: base,
    transport: baseTransport()
  });
}

export function createBaseWebSocketClient() {
  const url = getConfig().BASE_WS_RPC_URL;
  if (!url) {
    throw new Error("BASE_WS_RPC_URL is not configured in environment.");
  }

  return createPublicClient({
    chain: base,
    transport: webSocket(url, {
      retryCount: 3,
      timeout: 15_000
    })
  });
}

export function createBaseWalletClient() {
  const privateKey = getConfig().BASE_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("BASE_WALLET_PRIVATE_KEY is not configured in environment.");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const expectedAddress = getConfig().BASE_WALLET_ADDRESS.toLowerCase();
  if (account.address.toLowerCase() !== expectedAddress) {
    throw new Error("BASE_WALLET_PRIVATE_KEY does not match BASE_WALLET_ADDRESS.");
  }
  return createWalletClient({
    account,
    chain: base,
    transport: baseTransport()
  });
}

export function autopilotExecutorAddress() {
  const config = getConfig();
  return (config.AUTOPILOT_EXECUTOR_ADDRESS || config.BASE_WALLET_ADDRESS).toLowerCase();
}

export function createAutopilotExecutorWalletClient() {
  const config = getConfig();
  const privateKey = config.AUTOPILOT_EXECUTOR_PRIVATE_KEY || config.BASE_WALLET_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("AUTOPILOT_EXECUTOR_PRIVATE_KEY is not configured in environment.");
  }
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  const expectedAddress = autopilotExecutorAddress();
  if (account.address.toLowerCase() !== expectedAddress) {
    throw new Error("AUTOPILOT_EXECUTOR_PRIVATE_KEY does not match AUTOPILOT_EXECUTOR_ADDRESS.");
  }
  return createWalletClient({
    account,
    chain: base,
    transport: baseTransport()
  });
}
