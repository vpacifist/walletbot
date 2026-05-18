import { ClassificationStatus, Prisma } from "@prisma/client";
import { getAddress } from "viem";
import { createBaseClient } from "../src/lib/chain";
import { classifyTransaction } from "../src/lib/classifier";
import { prisma } from "../src/lib/db";
import { getWethUsdcUniswapV3PoolAddresses } from "../src/lib/uniswap-v3";

type RawRecord = {
  blockscout?: { method?: string | null };
  receipt?: unknown;
};

function readRaw(value: Prisma.JsonValue): RawRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as RawRecord) : {};
}

async function main() {
  const client = createBaseClient();
  const uniswapV3PoolAddresses = await getWethUsdcUniswapV3PoolAddresses(client);
  const transactions = await prisma.transaction.findMany({
    where: { classificationStatus: ClassificationStatus.partial },
    include: { wallet: true },
    orderBy: [{ blockNumber: "asc" }]
  });

  let updated = 0;
  let unchanged = 0;
  let skipped = 0;

  for (const transaction of transactions) {
    const raw = readRaw(transaction.raw);
    if (!raw.receipt) {
      skipped += 1;
      continue;
    }

    const classification = classifyTransaction({
      walletAddress: getAddress(transaction.wallet.address),
      fromAddress: getAddress(transaction.fromAddress),
      toAddress: transaction.toAddress ? getAddress(transaction.toAddress) : null,
      method: raw.blockscout?.method,
      receipt: raw.receipt as never,
      uniswapV3PoolAddresses
    });

    if (
      classification.type === transaction.type &&
      classification.status === transaction.classificationStatus &&
      classification.protocol === transaction.protocol
    ) {
      unchanged += 1;
      continue;
    }

    await prisma.transaction.update({
      where: { id: transaction.id },
      data: {
        type: classification.type,
        classificationStatus: classification.status,
        protocol: classification.protocol,
        tokenAmounts: classification.tokenAmounts,
        usdEstimate: classification.usdEstimate,
        relatedPositionTokenId: classification.relatedPositionTokenId
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
        partials: transactions.length,
        updated,
        unchanged,
        skipped,
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
