import { Prisma, SyncRunStatus } from "@/generated/prisma/client";
import { getAddress, type Address } from "viem";
import { fetchWalletTransactions } from "./blockscout";
import { createBaseClient } from "./chain";
import { classifyTransaction } from "./classifier";
import { getConfig } from "./config";
import { prisma } from "./db";
import { jsonSafe } from "./json";
import { applyPositionLifecycleClassification, updatePositionLiquidityState } from "./lp-lifecycle";
import { upsertTrackedPositions } from "./positions";
import { getWethUsdcUniswapV3PoolAddresses } from "./uniswap-v3";

const REBALANCER_TX_LOOKBACK_BLOCKS = 50_000n;

export async function ensureConfiguredWallet() {
  const address = getAddress(getConfig().BASE_WALLET_ADDRESS);
  return prisma.wallet.upsert({
    where: { address },
    create: { address, chain: "base", enabled: true },
    update: { enabled: true }
  });
}

async function fetchConfiguredWalletTransactions(walletAddress: string, fromBlock?: bigint) {
  const config = getConfig();
  const txs = await fetchWalletTransactions(walletAddress, fromBlock);
  const rebalancerAddress = config.AUTOPILOT_REBALANCER_ADDRESS ? getAddress(config.AUTOPILOT_REBALANCER_ADDRESS) : null;
  const executorAddress = config.AUTOPILOT_EXECUTOR_ADDRESS ? getAddress(config.AUTOPILOT_EXECUTOR_ADDRESS) : null;

  if (rebalancerAddress && executorAddress && executorAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    const lookbackFromBlock =
      fromBlock && fromBlock > REBALANCER_TX_LOOKBACK_BLOCKS ? fromBlock - REBALANCER_TX_LOOKBACK_BLOCKS : undefined;
    const executorTxs = await fetchWalletTransactions(executorAddress, lookbackFromBlock);
    txs.push(
      ...executorTxs.filter(
        (tx) => tx.from.hash.toLowerCase() === executorAddress.toLowerCase() && tx.to?.hash.toLowerCase() === rebalancerAddress.toLowerCase()
      )
    );
  }

  return [...new Map(txs.map((tx) => [tx.hash.toLowerCase(), tx])).values()].sort((a, b) => a.block_number - b.block_number);
}

export async function syncWalletOnce() {
  const wallet = await ensureConfiguredWallet();
  const client = createBaseClient();
  const run = await prisma.syncRun.create({
    data: {
      walletId: wallet.id,
      fromBlock: wallet.lastSyncedBlock ?? null,
      status: SyncRunStatus.running
    }
  });

  let seen = 0;
  let maxBlock = wallet.lastSyncedBlock ?? 0n;

  try {
    const txs = await fetchConfiguredWalletTransactions(wallet.address, wallet.lastSyncedBlock ?? undefined);
    const uniswapV3PoolAddresses = await getWethUsdcUniswapV3PoolAddresses(client).catch(() => new Set<string>());
    const positionLiquidityState = new Map<string, bigint>();
    const existingTransactions = await prisma.transaction.findMany({
      where: { walletId: wallet.id },
      select: { hash: true, raw: true },
      orderBy: [{ blockNumber: "asc" }, { timestamp: "asc" }]
    });
    const existingTransactionHashes = new Set(existingTransactions.map((transaction) => transaction.hash.toLowerCase()));
    for (const transaction of existingTransactions) {
      updatePositionLiquidityState(positionLiquidityState, transaction);
    }
    const discoveredTokenIds = new Set<string>();

    for (const tx of txs) {
      maxBlock = BigInt(tx.block_number) > maxBlock ? BigInt(tx.block_number) : maxBlock;
      if (existingTransactionHashes.has(tx.hash.toLowerCase())) continue;
      seen += 1;
      const receipt = await client.getTransactionReceipt({ hash: tx.hash as `0x${string}` }).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("Transaction receipt") && message.includes("could not be found")) return null;
        throw error;
      });
      if (!receipt) continue;
      const fromAddress = getAddress(tx.from.hash);
      const toAddress = tx.to?.hash ? getAddress(tx.to.hash) : null;
      const baseClassification = classifyTransaction({
        walletAddress: wallet.address as Address,
        fromAddress,
        toAddress,
        method: tx.method,
        nativeValueWei: tx.value,
        blockscout: tx,
        receipt,
        uniswapV3PoolAddresses
      });
      const classification = applyPositionLifecycleClassification(baseClassification, positionLiquidityState, {
        raw: { receipt }
      });

      if (classification.relatedPositionTokenId) {
        discoveredTokenIds.add(classification.relatedPositionTokenId);
      }

      await prisma.transaction.upsert({
        where: {
          walletId_hash: {
            walletId: wallet.id,
            hash: tx.hash
          }
        },
        create: {
          walletId: wallet.id,
          hash: tx.hash,
          blockNumber: BigInt(tx.block_number),
          timestamp: new Date(tx.timestamp),
          fromAddress,
          toAddress,
          type: classification.type,
          classificationStatus: classification.status,
          protocol: classification.protocol,
          tokenAmounts: classification.tokenAmounts,
          usdEstimate: classification.usdEstimate,
          relatedPositionTokenId: classification.relatedPositionTokenId,
          raw: jsonSafe({ blockscout: tx, receipt }) as Prisma.InputJsonValue
        },
        update: {
          type: classification.type,
          classificationStatus: classification.status,
          protocol: classification.protocol,
          tokenAmounts: classification.tokenAmounts,
          usdEstimate: classification.usdEstimate,
          relatedPositionTokenId: classification.relatedPositionTokenId,
          raw: jsonSafe({ blockscout: tx, receipt }) as Prisma.InputJsonValue
        }
      });
    }

    const positions = await upsertTrackedPositions(wallet.id, wallet.address as Address, [...discoveredTokenIds]);

    await prisma.wallet.update({
      where: { id: wallet.id },
      data: { lastSyncedBlock: maxBlock || wallet.lastSyncedBlock }
    });

    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: SyncRunStatus.succeeded,
        finishedAt: new Date(),
        toBlock: maxBlock || wallet.lastSyncedBlock,
        transactionsSeen: seen
      }
    });

    return { runId: run.id, transactionsSeen: seen, positionsSeen: positions.length, toBlock: maxBlock.toString() };
  } catch (error) {
    await prisma.syncRun.update({
      where: { id: run.id },
      data: {
        status: SyncRunStatus.failed,
        finishedAt: new Date(),
        transactionsSeen: seen,
        error: error instanceof Error ? error.message : String(error)
      }
    });
    throw error;
  }
}
