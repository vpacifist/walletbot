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

const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 750;
const MAX_PAGES = 100;
const HTTP_FETCH_ERROR_PREFIX = "Blockscout transaction fetch failed:";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

async function fetchBlockscoutPage(url: URL): Promise<BlockscoutResponse> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { accept: "application/json" }
      });

      if (response.ok) {
        return (await response.json()) as BlockscoutResponse;
      }

      const responseText = await response.text();
      const message = `${HTTP_FETCH_ERROR_PREFIX} ${response.status} ${responseText.slice(0, 500)}`;

      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      throw new Error(message);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith(HTTP_FETCH_ERROR_PREFIX)) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }

      throw error;
    }
  }

  throw new Error("Blockscout transaction fetch failed");
}

function buildTransactionsUrl(address: string, pageParams?: Record<string, string | number> | null) {
  const baseUrl = getConfig().BLOCKSCOUT_BASE_URL.replace(/\/$/, "");
  const url = new URL(`${baseUrl}/api/v2/addresses/${address}/transactions`);

  for (const [key, value] of Object.entries(pageParams ?? {})) {
    url.searchParams.set(key, String(value));
  }

  return url;
}

export async function fetchWalletTransactions(address: string, fromBlock?: bigint) {
  const transactions: BlockscoutTransaction[] = [];
  let pageParams: Record<string, string | number> | null | undefined;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await fetchBlockscoutPage(buildTransactionsUrl(address, pageParams));
    transactions.push(...payload.items);

    const oldestBlockOnPage = payload.items.at(-1)?.block_number;
    if ((fromBlock && oldestBlockOnPage && BigInt(oldestBlockOnPage) <= fromBlock) || !payload.next_page_params) {
      break;
    }

    pageParams = payload.next_page_params;
  }

  return transactions
    .filter((item) => !fromBlock || BigInt(item.block_number) > fromBlock)
    .sort((a, b) => a.block_number - b.block_number);
}
