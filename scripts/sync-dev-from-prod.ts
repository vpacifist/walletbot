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

const DEFAULT_PRODUCTION_BASE_URL = "https://walletbot-web-production.up.railway.app";

function productionBaseUrl() {
  return (process.env.WALLETBOT_PRODUCTION_BASE_URL || DEFAULT_PRODUCTION_BASE_URL).replace(/\/+$/, "");
}

async function fetchProductionStatus(): Promise<ProductionStatus> {
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

  return (await response.json()) as ProductionStatus;
}

function parseBlock(value: bigint | string | number | null | undefined) {
  if (value === null || value === undefined || value === "") return null;
  return BigInt(value);
}

async function main() {
  const strict = process.env.WALLETBOT_DEV_PROD_CHECK_STRICT === "1";
  const config = getConfig();
  const localAddress = getAddress(config.BASE_WALLET_ADDRESS);

  let productionStatus: ProductionStatus;
  try {
    productionStatus = await fetchProductionStatus();
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

  const wallet = await prisma.wallet.findUnique({ where: { address: localAddress } });
  const localBlock = parseBlock(wallet?.lastSyncedBlock);
  const productionBlock = parseBlock(productionStatus.lastSyncedBlock ?? productionStatus.latestRun?.toBlock);

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
    await prisma.wallet.update({
      where: { address: localAddress },
      data: { lastSyncedBlock: productionBlock }
    });
    console.log(`[dev] Local sync watermark advanced to production block ${productionBlock.toString()}`);
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
