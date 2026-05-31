import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { getAeroPriceUsdAtBlock, getEthPriceUsdAtBlock } from "@/lib/wallet-assets";

export type HistoricalPriceToken = "ETH" | "AERO";

export type HistoricalPricesByBlock = Record<
  string,
  {
    ethPriceUsd?: number | null;
    aeroPriceUsd?: number | null;
  }
>;

const TOKENS: HistoricalPriceToken[] = ["ETH", "AERO"];
const PRICE_LOAD_CONCURRENCY = 1;

async function runWithConcurrency(tasks: Array<() => Promise<void>>, concurrency: number) {
  const queue = [...tasks];
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const task = queue.shift();
      if (task) await task();
    }
  });

  await Promise.all(workers);
}

function priceField(token: HistoricalPriceToken) {
  return token === "ETH" ? "ethPriceUsd" : "aeroPriceUsd";
}

function parseBlockNumbers(blockNumbers: string[]) {
  return [...new Set(blockNumbers)].map((blockNumber) => BigInt(blockNumber));
}

function toPrice(value: Prisma.Decimal | null) {
  return value === null ? null : value.toNumber();
}

export async function readHistoricalPrices(blockNumbers: string[]): Promise<HistoricalPricesByBlock> {
  if (blockNumbers.length === 0) return {};

  const rows = await prisma.historicalTokenPrice.findMany({
    where: {
      token: { in: TOKENS },
      blockNumber: { in: parseBlockNumbers(blockNumbers) }
    }
  });

  const prices: HistoricalPricesByBlock = {};
  for (const row of rows) {
    const blockNumber = row.blockNumber.toString();
    prices[blockNumber] = {
      ...prices[blockNumber],
      [priceField(row.token as HistoricalPriceToken)]: toPrice(row.priceUsd)
    };
  }

  return prices;
}

async function cachePrice(token: HistoricalPriceToken, blockNumber: bigint, priceUsd: number | null) {
  await prisma.historicalTokenPrice.upsert({
    where: {
      token_blockNumber: {
        token,
        blockNumber
      }
    },
    create: {
      token,
      blockNumber,
      priceUsd: priceUsd === null ? null : new Prisma.Decimal(priceUsd)
    },
    update: {
      priceUsd: priceUsd === null ? null : new Prisma.Decimal(priceUsd),
      fetchedAt: new Date()
    }
  });
}

export async function loadAndCacheMissingHistoricalPrices(blockNumbers: string[]) {
  const uniqueBlockNumbers = parseBlockNumbers(blockNumbers);
  if (uniqueBlockNumbers.length === 0) return {};

  const cachedRows = await prisma.historicalTokenPrice.findMany({
    where: {
      token: { in: TOKENS },
      blockNumber: { in: uniqueBlockNumbers }
    },
    select: {
      token: true,
      blockNumber: true,
      priceUsd: true
    }
  });
  const cachedKeys = new Set(
    cachedRows.filter((row) => row.priceUsd !== null).map((row) => `${row.token}:${row.blockNumber.toString()}`)
  );

  const tasks = uniqueBlockNumbers.flatMap((blockNumber) => {
    const blockTasks: Array<() => Promise<void>> = [];
    if (!cachedKeys.has(`ETH:${blockNumber.toString()}`)) {
      blockTasks.push(() =>
        getEthPriceUsdAtBlock(blockNumber).then((priceUsd) =>
          priceUsd === null ? Promise.resolve() : cachePrice("ETH", blockNumber, priceUsd)
        )
      );
    }
    if (!cachedKeys.has(`AERO:${blockNumber.toString()}`)) {
      blockTasks.push(() =>
        getAeroPriceUsdAtBlock(blockNumber).then((priceUsd) =>
          priceUsd === null ? Promise.resolve() : cachePrice("AERO", blockNumber, priceUsd)
        )
      );
    }
    return blockTasks;
  });

  await runWithConcurrency(tasks, PRICE_LOAD_CONCURRENCY);

  return readHistoricalPrices(blockNumbers);
}
