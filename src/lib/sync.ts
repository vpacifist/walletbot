import { PositionStatus, Prisma, SyncRunStatus } from "@/generated/prisma/client";
import { createPublicClient, getAddress, http, type Address } from "viem";
import { base } from "viem/chains";
import { fetchWalletTransactions } from "./blockscout";
import { baseRpcUrls, createBaseClient } from "./chain";
import { classifyTransaction } from "./classifier";
import { getConfig } from "./config";
import { prisma } from "./db";
import { jsonSafe } from "./json";
import { applyPositionLifecycleClassification, updatePositionLiquidityState } from "./lp-lifecycle";
import { upsertTrackedPositions } from "./positions";
import { getWethUsdcUniswapV3PoolAddresses } from "./uniswap-v3";

const REBALANCER_TX_LOOKBACK_BLOCKS = 50_000n;
const PUBLIC_BASE_RPC_URL = "https://mainnet.base.org";

export type SyncWalletOptions = {
  fromBlock?: bigint | null;
};

export async function ensureConfiguredWallet() {
  const address = getAddress(getConfig().BASE_WALLET_ADDRESS);
  return prisma.wallet.upsert({
    where: { address },
    create: { address, chain: "base", enabled: true },
    update: { enabled: true }
  });
}

function splitAddressList(value: string) {
  return value.split(/[\s,;]+/).filter(Boolean);
}

function uniqueAddresses(addresses: string[]) {
  return [...new Map(addresses.map((address) => [address.toLowerCase(), address])).values()];
}

export function configuredRebalancerAddresses() {
  const config = getConfig();
  const addresses = [
    config.AUTOPILOT_REBALANCER_ADDRESS,
    ...splitAddressList(config.AUTOPILOT_REBALANCER_ADDRESSES)
  ].filter(Boolean);

  return uniqueAddresses(addresses.map((address) => getAddress(address)));
}

export async function fetchConfiguredWalletTransactions(walletAddress: string, fromBlock?: bigint) {
  const config = getConfig();
  const txs = await fetchWalletTransactions(walletAddress, fromBlock);
  const rebalancerAddresses = configuredRebalancerAddresses();
  const rebalancerAddressSet = new Set(rebalancerAddresses.map((address) => address.toLowerCase()));
  const executorAddress = config.AUTOPILOT_EXECUTOR_ADDRESS ? getAddress(config.AUTOPILOT_EXECUTOR_ADDRESS) : null;

  if (rebalancerAddressSet.size > 0 && executorAddress && executorAddress.toLowerCase() !== walletAddress.toLowerCase()) {
    const lookbackFromBlock =
      fromBlock && fromBlock > REBALANCER_TX_LOOKBACK_BLOCKS ? fromBlock - REBALANCER_TX_LOOKBACK_BLOCKS : undefined;
    const executorTxs = await fetchWalletTransactions(executorAddress, lookbackFromBlock);
    txs.push(
      ...executorTxs.filter(
        (tx) =>
          tx.from.hash.toLowerCase() === executorAddress.toLowerCase() &&
          Boolean(tx.to?.hash && rebalancerAddressSet.has(tx.to.hash.toLowerCase()))
      )
    );
  }

  return [...new Map(txs.map((tx) => [tx.hash.toLowerCase(), tx])).values()].sort((a, b) => a.block_number - b.block_number);
}

function isMissingReceiptError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Transaction receipt") && message.includes("could not be found");
}

async function getTransactionReceiptWithFallback(client: ReturnType<typeof createBaseClient>, hash: `0x${string}`) {
  try {
    return await client.getTransactionReceipt({ hash });
  } catch (error) {
    if (!isMissingReceiptError(error)) throw error;
  }

  for (const url of [...new Set([...baseRpcUrls(), PUBLIC_BASE_RPC_URL])]) {
    try {
      const fallbackClient = createPublicClient({
        chain: base,
        transport: http(url, {
          retryCount: 2,
          timeout: 15_000
        })
      });
      return await fallbackClient.getTransactionReceipt({ hash });
    } catch (error) {
      if (!isMissingReceiptError(error)) continue;
    }
  }

  return null;
}

export async function syncWalletOnce(options: SyncWalletOptions = {}) {
  const wallet = await ensureConfiguredWallet();
  const fromBlock = options.fromBlock === null ? undefined : options.fromBlock ?? wallet.lastSyncedBlock ?? undefined;
  const client = createBaseClient();
  const run = await prisma.syncRun.create({
    data: {
      walletId: wallet.id,
      fromBlock: fromBlock ?? null,
      status: SyncRunStatus.running
    }
  });

  let seen = 0;
  let maxBlock = wallet.lastSyncedBlock ?? 0n;

  try {
    const txs = await fetchConfiguredWalletTransactions(wallet.address, fromBlock);
    const uniswapV3PoolAddresses = await getWethUsdcUniswapV3PoolAddresses(client).catch(() => new Set<string>());
    const positionLiquidityState = new Map<string, bigint>();
    const existingTransactions = await prisma.transaction.findMany({
      where: { walletId: wallet.id },
      select: { hash: true, blockNumber: true, raw: true },
      orderBy: [{ blockNumber: "asc" }, { timestamp: "asc" }]
    });
    const existingTransactionsByHash = new Map(existingTransactions.map((transaction) => [transaction.hash.toLowerCase(), transaction]));
    const stateSeedTransactions = fromBlock
      ? existingTransactions.filter((transaction) => transaction.blockNumber <= fromBlock)
      : [];
    for (const transaction of stateSeedTransactions) {
      updatePositionLiquidityState(positionLiquidityState, transaction);
    }
    const discoveredTokenIds = new Set<string>();

    for (const tx of txs) {
      maxBlock = BigInt(tx.block_number) > maxBlock ? BigInt(tx.block_number) : maxBlock;
      const existingTransaction = existingTransactionsByHash.get(tx.hash.toLowerCase());
      if (existingTransaction) {
        updatePositionLiquidityState(positionLiquidityState, existingTransaction);
        continue;
      }
      seen += 1;
      const receipt = await getTransactionReceiptWithFallback(client, tx.hash as `0x${string}`);
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

    const trackedPositions = await prisma.position.findMany({
      where: {
        walletId: wallet.id,
        status: { not: PositionStatus.closed_or_zero_liquidity }
      },
      select: { tokenId: true }
    });
    for (const position of trackedPositions) {
      discoveredTokenIds.add(position.tokenId);
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
