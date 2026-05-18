import { getConfig } from "./config";

export type BlockscoutTransaction = {
  hash: string;
  block_number: number;
  timestamp: string;
  from: { hash: string };
  to: { hash: string } | null;
  value: string;
  status?: string;
  method?: string;
};

type BlockscoutResponse = {
  items: BlockscoutTransaction[];
  next_page_params?: Record<string, string | number> | null;
};

export async function fetchWalletTransactions(address: string, fromBlock?: bigint) {
  const baseUrl = getConfig().BLOCKSCOUT_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${baseUrl}/api/v2/addresses/${address}/transactions`);

  const response = await fetch(url, {
    headers: { accept: "application/json" }
  });

  if (!response.ok) {
    throw new Error(`Blockscout transaction fetch failed: ${response.status} ${await response.text()}`);
  }

  const payload = (await response.json()) as BlockscoutResponse;
  return payload.items
    .filter((item) => !fromBlock || BigInt(item.block_number) > fromBlock)
    .sort((a, b) => a.block_number - b.block_number);
}
