import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { getConfig } from "./config";

export function createBaseClient() {
  return createPublicClient({
    chain: base,
    transport: http(getConfig().BASE_RPC_URL, {
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
    transport: http(getConfig().BASE_RPC_URL)
  });
}
