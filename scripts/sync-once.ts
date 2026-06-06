import { prisma } from "../src/lib/db";
import { syncWalletOnce } from "../src/lib/sync";

async function main() {
  const fromBlock = process.env.WALLETBOT_SYNC_FROM_BLOCK ? BigInt(process.env.WALLETBOT_SYNC_FROM_BLOCK) : undefined;
  const result = await syncWalletOnce({ fromBlock });
  const prefix = fromBlock ? `Backfilled from block ${fromBlock}. ` : "";
  console.log(
    `${prefix}Synced ${result.transactionsSeen} tx, ${result.positionsSeen} positions. Latest block ${result.toBlock}.`
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
