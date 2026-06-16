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
const FETCH_TIMEOUT_MS = 10_000;
const FETCH_TOTAL_TIMEOUT_MS = 30_000;
const MAX_PAGES = 100;
const HTTP_FETCH_ERROR_PREFIX = "Blockscout transaction fetch failed:";

function sleep(ms: number, deadlineMs?: number) {
  if (deadlineMs !== undefined && Date.now() + ms > deadlineMs) {
    return Promise.reject(new Error(`${HTTP_FETCH_ERROR_PREFIX} request timed out`));
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number) {
  return status === 429 || status >= 500;
}

async function fetchWithTimeout(url: URL, deadlineMs?: number) {
  const remainingMs = deadlineMs === undefined ? FETCH_TIMEOUT_MS : Math.min(FETCH_TIMEOUT_MS, deadlineMs - Date.now());
  if (remainingMs <= 0) throw new Error(`${HTTP_FETCH_ERROR_PREFIX} request timed out`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remainingMs);
  try {
    return await fetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBlockscoutPage(url: URL, deadlineMs: number): Promise<BlockscoutResponse> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await fetchWithTimeout(url, deadlineMs);

      if (response.ok) {
        return (await response.json()) as BlockscoutResponse;
      }

      const responseText = await response.text();
      const message = `${HTTP_FETCH_ERROR_PREFIX} ${response.status} ${responseText.slice(0, 500)}`;

      if (isRetryableStatus(response.status) && attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * attempt, deadlineMs);
        continue;
      }

      throw new Error(message);
    } catch (error) {
      lastError = error;
      if (error instanceof Error && error.message.startsWith(HTTP_FETCH_ERROR_PREFIX)) {
        throw error;
      }

      if (attempt < MAX_RETRIES) {
        await sleep(RETRY_BASE_DELAY_MS * attempt, deadlineMs);
        continue;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${HTTP_FETCH_ERROR_PREFIX} ${message || "request timed out"}`);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError ?? "request timed out");
  throw new Error(`${HTTP_FETCH_ERROR_PREFIX} ${message}`);
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
  const deadlineMs = Date.now() + FETCH_TOTAL_TIMEOUT_MS;

  for (let page = 0; page < MAX_PAGES; page += 1) {
    if (Date.now() >= deadlineMs) throw new Error(`${HTTP_FETCH_ERROR_PREFIX} request timed out`);

    const payload = await fetchBlockscoutPage(buildTransactionsUrl(address, pageParams), deadlineMs);
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
