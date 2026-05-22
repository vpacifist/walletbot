import { prisma } from "../src/lib/db";
import { syncWalletOnce } from "../src/lib/sync";

async function main() {
  const result = await syncWalletOnce();
  console.log(
    `Synced ${result.transactionsSeen} tx, ${result.positionsSeen} positions. Latest block ${result.toBlock}.`
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
