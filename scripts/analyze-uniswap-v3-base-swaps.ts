import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import path from "node:path";
import { loadEnvConfig } from "@next/env";

loadEnvConfig(process.cwd());

const POOL_ADDRESS = "0x6c561B446416E1A00E8E93E221854d6eA4171372".toLowerCase();
const SWAP_TOPIC0 = "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67";
const CACHE_DIR = path.join(process.cwd(), "data", "cache", "uniswap-v3-base-weth-usdc-3000");
const RAW_JSONL = path.join(CACHE_DIR, "swaps.jsonl");
const SUMMARY_JSON = path.join(CACHE_DIR, "summary.json");
const MS_PER_DAY = 24 * 60 * 60 * 1000;

type DuneRow = {
  block_time: string;
  block_number: number;
  tx_hash: string;
  log_index: number;
  data: string;
};

type SwapRow = {
  ts: string;
  blockNumber: number;
  txHash: string;
  logIndex: number;
  amount0: string;
  amount1: string;
  sqrtPriceX96: string;
  liquidity: string;
  tick: number;
  price: number;
};

function arg(name: string, fallback: string) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isoSql(date: Date) {
  return date.toISOString().replace("T", " ").replace(/\.\d{3}Z$/, "");
}

function datePart(date: Date) {
  return date.toISOString().slice(0, 10);
}

function signedWord(hex: string) {
  const value = BigInt(`0x${hex}`);
  return value >= (1n << 255n) ? value - (1n << 256n) : value;
}

function unsignedWord(hex: string) {
  return BigInt(`0x${hex}`);
}

function priceFromTick(tick: number) {
  return Math.pow(1.0001, tick) * 1e12;
}

function decodeSwap(row: DuneRow): SwapRow {
  const data = row.data.startsWith("0x") ? row.data.slice(2) : row.data;
  const words = Array.from({ length: 5 }, (_, index) => data.slice(index * 64, (index + 1) * 64));
  const tick = Number(signedWord(words[4]));
  return {
    ts: row.block_time,
    blockNumber: row.block_number,
    txHash: row.tx_hash,
    logIndex: row.log_index,
    amount0: signedWord(words[0]).toString(),
    amount1: signedWord(words[1]).toString(),
    sqrtPriceX96: unsignedWord(words[2]).toString(),
    liquidity: unsignedWord(words[3]).toString(),
    tick,
    price: priceFromTick(tick)
  };
}

async function duneRequest<T>(url: string, init?: RequestInit): Promise<T> {
  const key = process.env.DUNE_API_KEY;
  if (!key) throw new Error("DUNE_API_KEY is not configured.");

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const response = await fetch(url, {
      ...init,
      headers: {
        "X-Dune-API-Key": key,
        "Content-Type": "application/json",
        ...(init?.headers ?? {})
      }
    });
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as T;
    if (response.status !== 429 || attempt === 5) {
      throw new Error(`Dune request failed ${response.status}: ${text.slice(0, 500)}`);
    }
    await sleep(2_000 * (attempt + 1));
  }

  throw new Error("Dune request retries exhausted.");
}

async function executeSql(sql: string) {
  const started = await duneRequest<{ execution_id: string }>("https://api.dune.com/api/v1/sql/execute", {
    method: "POST",
    body: JSON.stringify({ sql, performance: "small" })
  });

  for (let attempt = 0; attempt < 240; attempt += 1) {
    await sleep(1_500);
    const status = await duneRequest<{ state: string; is_execution_finished?: boolean; error?: unknown }>(
      `https://api.dune.com/api/v1/execution/${started.execution_id}/status`
    );
    if (status.state === "QUERY_STATE_FAILED") throw new Error(`Dune query failed: ${JSON.stringify(status.error ?? status)}`);
    if (status.is_execution_finished || status.state === "QUERY_STATE_COMPLETED") return started.execution_id;
  }

  throw new Error(`Dune query timed out: ${started.execution_id}`);
}

async function readResults(executionId: string) {
  const limit = 10_000;
  const rows: DuneRow[] = [];
  for (let offset = 0; ; offset += limit) {
    const result = await duneRequest<{
      result?: {
        rows?: DuneRow[];
        metadata?: { total_row_count?: number };
      };
    }>(`https://api.dune.com/api/v1/execution/${executionId}/results?limit=${limit}&offset=${offset}`);
    const page = result.result?.rows ?? [];
    rows.push(...page);
    const total = result.result?.metadata?.total_row_count ?? rows.length;
    if (rows.length >= total || page.length === 0) return rows;
  }
}

function chunkSql(start: Date, end: Date) {
  return `
select
  block_time,
  block_number,
  tx_hash,
  "index" as log_index,
  data
from base.logs
where contract_address = ${POOL_ADDRESS}
  and topic0 = ${SWAP_TOPIC0}
  and block_time >= timestamp '${isoSql(start)}'
  and block_time < timestamp '${isoSql(end)}'
order by block_number, "index"
`;
}

async function download(days: number, chunkDays: number) {
  await mkdir(CACHE_DIR, { recursive: true });
  const end = new Date(arg("end", new Date().toISOString()));
  const start = process.argv.some((value) => value.startsWith("--start="))
    ? new Date(arg("start", ""))
    : new Date(end.getTime() - days * MS_PER_DAY);
  const append = process.argv.includes("--append");
  const tmp = `${RAW_JSONL}.tmp`;
  const stream = createWriteStream(append ? RAW_JSONL : tmp, { encoding: "utf8", flags: append ? "a" : "w" });
  let totalRows = 0;

  for (let cursor = start; cursor < end; cursor = new Date(cursor.getTime() + chunkDays * MS_PER_DAY)) {
    const chunkEnd = new Date(Math.min(end.getTime(), cursor.getTime() + chunkDays * MS_PER_DAY));
    process.stderr.write(`Dune ${datePart(cursor)} -> ${datePart(chunkEnd)}... `);
    const executionId = await executeSql(chunkSql(cursor, chunkEnd));
    const rows = await readResults(executionId);
    for (const row of rows) stream.write(`${JSON.stringify(decodeSwap(row))}\n`);
    totalRows += rows.length;
    process.stderr.write(`${rows.length} swaps\n`);
  }

  await new Promise<void>((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
  if (!append) await rename(tmp, RAW_JSONL);
  return { rows: totalRows, start: start.toISOString(), end: end.toISOString() };
}

async function loadSwaps() {
  const content = await readFile(RAW_JSONL, "utf8");
  const byLog = new Map<string, SwapRow>();
  for (const row of content
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line) as SwapRow;
      return { ...row, price: priceFromTick(row.tick) };
    })) {
    byLog.set(`${row.blockNumber}:${row.logIndex}:${row.txHash.toLowerCase()}`, row);
  }

  return [...byLog.values()].sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex);
}

function percentile(values: number[], p: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))];
}

function min(values: number[]) {
  return values.reduce((best, value) => Math.min(best, value), Number.POSITIVE_INFINITY);
}

function max(values: number[]) {
  return values.reduce((best, value) => Math.max(best, value), Number.NEGATIVE_INFINITY);
}

function alignLower(tick: number, spacing = 60) {
  return Math.floor(tick / spacing) * spacing;
}

function timestampMs(value: string) {
  return new Date(value.replace(" UTC", "Z")).getTime();
}

function simulate(swaps: SwapRow[], config: { widthTicks: number; confirmSeconds: number; driftBps: number }) {
  let lower = alignLower(swaps[0].tick);
  let upper = lower + config.widthTicks;
  let pending: { dir: "up" | "down"; boundaryTick: number; startMs: number; maxDriftBps: number } | null = null;
  const events: Array<{ ok: boolean; driftBps: number; dir: "up" | "down"; confirmSeconds: number }> = [];

  for (let index = 1; index < swaps.length; index += 1) {
    const swap = swaps[index];
    const dir = swap.tick >= upper ? "up" : swap.tick < lower ? "down" : null;
    if (!dir) {
      pending = null;
      continue;
    }

    const boundaryTick = dir === "up" ? upper : lower;
    const boundaryPrice = priceFromTick(boundaryTick);
    const driftBps = (Math.abs(swap.price - boundaryPrice) / boundaryPrice) * 10_000;
    if (!pending || pending.dir !== dir || pending.boundaryTick !== boundaryTick) {
      pending = { dir, boundaryTick, startMs: timestampMs(swap.ts), maxDriftBps: driftBps };
    }

    pending.maxDriftBps = Math.max(pending.maxDriftBps, driftBps);
    const elapsedSeconds = (timestampMs(swap.ts) - pending.startMs) / 1000;
    if (elapsedSeconds >= config.confirmSeconds) {
      const ok = pending.maxDriftBps <= config.driftBps;
      events.push({ ok, driftBps: pending.maxDriftBps, dir, confirmSeconds: elapsedSeconds });
      lower = alignLower(swap.tick);
      upper = lower + config.widthTicks;
      pending = null;
    }
  }

  const drifts = events.map((event) => event.driftBps);
  return {
    ...config,
    events: events.length,
    ok: events.filter((event) => event.ok).length,
    late: events.filter((event) => !event.ok).length,
    lateRatePct: events.length ? (events.filter((event) => !event.ok).length / events.length) * 100 : 0,
    driftP50Bps: percentile(drifts, 0.5),
    driftP90Bps: percentile(drifts, 0.9),
    driftP95Bps: percentile(drifts, 0.95),
    driftMaxBps: drifts.length ? max(drifts) : 0
  };
}

async function summarize(downloadMeta?: { rows: number; start: string; end: string }) {
  const swaps = await loadSwaps();
  const prices = swaps.map((swap) => swap.price);
  const tickMoves = swaps.slice(1).map((swap, index) => Math.abs(swap.tick - swaps[index].tick));
  const configs = [];
  for (const widthTicks of [60, 120, 180, 240]) {
    for (const confirmSeconds of [30, 60, 120, 300]) {
      for (const driftBps of [5, 10, 20, 30]) {
        configs.push(simulate(swaps, { widthTicks, confirmSeconds, driftBps }));
      }
    }
  }
  configs.sort((left, right) => left.lateRatePct - right.lateRatePct || left.events - right.events);

  const summary = {
    pool: POOL_ADDRESS,
    source: "Dune base.logs raw Swap events",
    generatedAt: new Date().toISOString(),
    download: downloadMeta,
    swaps: swaps.length,
    firstSwap: swaps[0]?.ts,
    lastSwap: swaps.at(-1)?.ts,
    price: {
      start: prices[0],
      end: prices.at(-1),
      min: min(prices),
      max: max(prices)
    },
    tickMovePerSwap: {
      p50: percentile(tickMoves, 0.5),
      p90: percentile(tickMoves, 0.9),
      p95: percentile(tickMoves, 0.95),
      p99: percentile(tickMoves, 0.99),
      max: max(tickMoves)
    },
    strategies: configs.slice(0, 32)
  };

  await writeFile(SUMMARY_JSON, `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

async function main() {
  const days = Number(arg("days", "90"));
  const chunkDays = Number(arg("chunk-days", "1"));
  const useExisting = process.argv.includes("--use-existing");
  let downloadMeta: { rows: number; start: string; end: string } | undefined;

  if (!useExisting) {
    downloadMeta = await download(days, chunkDays);
  } else {
    await stat(RAW_JSONL);
  }

  const summary = await summarize(downloadMeta);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
