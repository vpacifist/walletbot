import { ClassificationStatus, Prisma } from "../src/generated/prisma/client";
import { getAddress } from "viem";
import { createBaseClient } from "../src/lib/chain";
import { classifyTransaction } from "../src/lib/classifier";
import { prisma } from "../src/lib/db";
import { applyPositionLifecycleClassification } from "../src/lib/lp-lifecycle";
import { getWethUsdcUniswapV3PoolAddresses } from "../src/lib/uniswap-v3";

type RawRecord = {
  blockscout?: { method?: string | null; value?: string | null };
  receipt?: unknown;
};

function readRaw(value: Prisma.JsonValue): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

async function main() {
  const hashArg = process.argv.find((arg) => arg.startsWith("--hash="))?.slice("--hash=".length);
  const reclassifyAll = process.argv.includes("--all");
  const client = createBaseClient();
  const uniswapV3PoolAddresses = await getWethUsdcUniswapV3PoolAddresses(client);
  const transactions = await prisma.transaction.findMany({
    where: hashArg ? { hash: hashArg } : reclassifyAll ? {} : { classificationStatus: ClassificationStatus.partial },
    include: { wallet: true },
    orderBy: [{ blockNumber: "asc" }]
  });

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;
  const positionLiquidityState = new Map<string, bigint>();

  for (const transaction of transactions) {
    const raw = readRaw(transaction.raw);
    if (!raw.receipt) {
      skipped += 1;
      continue;
    }

    const baseClassification = classifyTransaction({
      walletAddress: getAddress(transaction.wallet.address),
      fromAddress: getAddress(transaction.fromAddress),
      toAddress: transaction.toAddress ? getAddress(transaction.toAddress) : null,
      method: raw.blockscout?.method,
      nativeValueWei: raw.blockscout?.value,
      blockscout: raw.blockscout,
      receipt: raw.receipt as never,
      uniswapV3PoolAddresses
    });
    const classification = applyPositionLifecycleClassification(baseClassification, positionLiquidityState, transaction);

    if (
      classification.type === transaction.type &&
      classification.status === transaction.classificationStatus &&
      (classification.protocol ?? null) === transaction.protocol &&
      JSON.stringify(classification.tokenAmounts) === JSON.stringify(transaction.tokenAmounts) &&
      (classification.usdEstimate ?? null) === transaction.usdEstimate?.toString() &&
      (classification.relatedPositionTokenId ?? null) === transaction.relatedPositionTokenId
    ) {
      unchanged += 1;
      continue;
    }

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        type: classification.type,
        classificationStatus: classification.status,
        protocol: classification.protocol ?? null,
        tokenAmounts: classification.tokenAmounts,
        usdEstimate: classification.usdEstimate ?? null,
        relatedPositionTokenId: classification.relatedPositionTokenId ?? null
      }
    });

    updated += 1;
    console.log(
      `${transaction.hash}: ${transaction.type}/${transaction.classificationStatus}/${transaction.protocol ?? "-"} -> ${classification.type}/${classification.status}/${classification.protocol ?? "-"}`
    );
  }

  console.log(
    JSON.stringify(
      {
        selected: transactions.length,
        updated,
        unchanged,
        skipped,
        hash: hashArg ?? null,
        all: reclassifyAll,
        uniswapV3Pools: [...uniswapV3PoolAddresses]
      },
      null,
      2
    )
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
