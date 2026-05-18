import { createPublicClient, http } from "viem";
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
