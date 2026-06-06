import { getAddress } from "viem";
import { getConfig } from "../src/lib/config";
import { prisma } from "../src/lib/db";
import { syncWalletOnce } from "../src/lib/sync";

type ProductionStatus = {
  walletAddress?: string;
  lastSyncedBlock?: string | null;
  latestRun?: {
    status?: string;
    toBlock?: string | null;
    finishedAt?: string | null;
  } | null;
};

type ProductionTransaction = {
  hash: string;
  blockNumber: string | number;
};

const DEFAULT_PRODUCTION_BASE_URL = "https://walletbot-web-production.up.railway.app";

function productionBaseUrl() {
  return (process.env.WALLETBOT_PRODUCTION_BASE_URL || DEFAULT_PRODUCTION_BASE_URL).replace(/\/+$/, "");
}

async function fetchProductionSnapshot(): Promise<{ status: ProductionStatus; transactions: ProductionTransaction[] }> {
  const config = getConfig();
  const baseUrl = productionBaseUrl();
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    body: new URLSearchParams({ password: config.APP_PASSWORD }),
    redirect: "manual"
  });
  const cookie = loginResponse.headers.get("set-cookie")?.split(";")[0];
  if (!cookie) throw new Error(`Production login did not return a session cookie; status ${loginResponse.status}`);

  const response = await fetch(`${baseUrl}/api/settings/status`, {
    cache: "no-store",
    headers: { cookie }
  });
  if (!response.ok) throw new Error(`Production status failed with status ${response.status}`);

  const transactionsResponse = await fetch(`${baseUrl}/api/transactions`, {
    cache: "no-store",
    headers: { cookie }
  });
  if (!transactionsResponse.ok) throw new Error(`Production transactions failed with status ${transactionsResponse.status}`);

  return {
    status: (await response.json()) as ProductionStatus,
    transactions: (await transactionsResponse.json()) as ProductionTransaction[]
  };
}

function parseBlock(value: bigint | string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  return BigInt(value);
}

async function missingProductionTransactions(walletId: string, productionTransactions: ProductionTransaction[]) {
  const uniqueProductionTransactions = [...new Map(productionTransactions.map((transaction) => [transaction.hash.toLowerCase(), transaction])).values()];
  if (uniqueProductionTransactions.length === 0) return [];

  const existingTransactions = await prisma.transaction.findMany({
    where: {
      walletId,
      hash: { in: uniqueProductionTransactions.map((transaction) => transaction.hash) }
    },
    select: { hash: true }
  });
  const existingHashes = new Set(existingTransactions.map((transaction) => transaction.hash.toLowerCase()));
  return uniqueProductionTransactions.filter((transaction) => !existingHashes.has(transaction.hash.toLowerCase()));
}

function earliestBackfillBlock(transactions: ProductionTransaction[]) {
  const blocks = transactions.map((transaction) => parseBlock(transaction.blockNumber)).filter((block): block is bigint => block !== null);
  if (blocks.length === 0) return undefined;
  const earliest = blocks.reduce((min, block) => (block < min ? block : min));
  return earliest > 0n ? earliest - 1n : 0n;
}

async function main() {
  const strict = process.env.WALLETBOT_DEV_PROD_CHECK_STRICT === "1";
  const config = getConfig();
  const localAddress = getAddress(config.BASE_WALLET_ADDRESS);

  let productionStatus: ProductionStatus;
  let productionTransactions: ProductionTransaction[];
  try {
    const productionSnapshot = await fetchProductionSnapshot();
    productionStatus = productionSnapshot.status;
    productionTransactions = productionSnapshot.transactions;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (strict) throw error;
    console.warn(`[dev] Production sync check skipped: ${message}`);
    return;
  }

  const productionAddress = productionStatus.walletAddress ? getAddress(productionStatus.walletAddress) : null;
  if (!productionAddress || productionAddress !== localAddress) {
    const suffix = productionAddress ? ` (${productionAddress} != ${localAddress})` : "";
    const message = `Production wallet does not match local wallet${suffix}`;
    if (strict) throw new Error(message);
    console.warn(`[dev] Production sync check skipped: ${message}`);
    return;
  }

  let wallet = await prisma.wallet.findUnique({ where: { address: localAddress } });
  let localBlock = parseBlock(wallet?.lastSyncedBlock);
  const productionBlock = parseBlock(productionStatus.lastSyncedBlock ?? productionStatus.latestRun?.toBlock);

  if (wallet && productionTransactions.length > 0) {
    const missingTransactions = await missingProductionTransactions(wallet.id, productionTransactions);
    if (missingTransactions.length > 0) {
      const fromBlock = earliestBackfillBlock(missingTransactions);
      const suffix = fromBlock ? ` from block ${fromBlock.toString()}` : "";
      console.log(`[dev] Production has ${missingTransactions.length} visible txs missing locally; backfilling${suffix}`);
      await syncWalletOnce({ fromBlock });
      wallet = await prisma.wallet.findUnique({ where: { address: localAddress } });
      const remainingMissingTransactions = wallet ? await missingProductionTransactions(wallet.id, productionTransactions) : missingTransactions;

      if (remainingMissingTransactions.length > 0) {
        const message =
          `Local database is still missing ${remainingMissingTransactions.length} production-visible txs; ` +
          "not advancing the sync watermark. Check AUTOPILOT_EXECUTOR_ADDRESS and AUTOPILOT_REBALANCER_ADDRESSES.";
        if (strict) throw new Error(message);
        console.warn(`[dev] ${message}`);
        return;
      }
    }
    localBlock = parseBlock(wallet?.lastSyncedBlock);
  }

  if (!productionBlock) {
    console.log("[dev] Production has no synced block yet; local refresh can continue normally");
    return;
  }

  const localLabel = localBlock?.toString() ?? "never";
  console.log(`[dev] Sync position: local=${localLabel}, production=${productionBlock.toString()}`);

  if (localBlock !== null && localBlock >= productionBlock) {
    console.log("[dev] Local database is not behind production");
    return;
  }

  console.log("[dev] Production is ahead; refreshing local wallet data from Base");
  const result = await syncWalletOnce();
  const refreshedBlock = parseBlock(result.toBlock);
  if (refreshedBlock === null || refreshedBlock < productionBlock) {
    const message =
      `Local sync reached block ${refreshedBlock?.toString() ?? "never"}, below production block ${productionBlock.toString()}; ` +
      "leaving the local watermark unchanged.";
    if (strict) throw new Error(message);
    console.warn(`[dev] ${message}`);
  }
  console.log(
    `[dev] Local wallet refresh completed: ${result.transactionsSeen} txs, ${result.positionsSeen} positions, toBlock=${result.toBlock}`
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
