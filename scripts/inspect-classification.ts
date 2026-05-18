import { PrismaClient } from "@prisma/client";
import { getTransactionLpDelta } from "../src/lib/wallet-assets";

const prisma = new PrismaClient();

async function main() {
  const hash = process.argv[2];
  const byStatus = await prisma.transaction.groupBy({ by: ["classificationStatus"], _count: true });
  const target = hash
    ? await prisma.transaction.findFirst({
        where: { hash },
        select: {
          hash: true,
          type: true,
          classificationStatus: true,
          protocol: true,
          relatedPositionTokenId: true,
          tokenAmounts: true,
          fromAddress: true,
          toAddress: true,
          raw: true
        }
      })
    : null;

  console.log(
    JSON.stringify(
      {
        byStatus,
        target: target
          ? {
              hash: target.hash,
              type: target.type,
              classificationStatus: target.classificationStatus,
              protocol: target.protocol,
              relatedPositionTokenId: target.relatedPositionTokenId,
              tokenAmounts: target.tokenAmounts,
              lpDelta: getTransactionLpDelta(target)
            }
          : null
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
