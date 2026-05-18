-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TransactionType" AS ENUM ('deposit', 'withdrawal', 'lp_increase', 'lp_decrease', 'lp_collect', 'swap', 'unknown');

-- CreateEnum
CREATE TYPE "ClassificationStatus" AS ENUM ('classified', 'partial', 'unknown');

-- CreateEnum
CREATE TYPE "PositionStatus" AS ENUM ('in_range', 'below_range', 'above_range', 'closed_or_zero_liquidity', 'unknown');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('running', 'succeeded', 'failed');

-- CreateTable
CREATE TABLE "Wallet" (
    "id" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "chain" TEXT NOT NULL DEFAULT 'base',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastSyncedBlock" BIGINT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wallet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "fromAddress" TEXT NOT NULL,
    "toAddress" TEXT,
    "type" "TransactionType" NOT NULL DEFAULT 'unknown',
    "classificationStatus" "ClassificationStatus" NOT NULL DEFAULT 'unknown',
    "protocol" TEXT,
    "tokenAmounts" JSONB NOT NULL DEFAULT '[]',
    "usdEstimate" DECIMAL(30,8),
    "relatedPositionTokenId" TEXT,
    "raw" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Position" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "poolAddress" TEXT,
    "token0" TEXT NOT NULL,
    "token1" TEXT NOT NULL,
    "fee" INTEGER NOT NULL,
    "tickLower" INTEGER NOT NULL,
    "tickUpper" INTEGER NOT NULL,
    "currentTick" INTEGER,
    "liquidity" TEXT NOT NULL,
    "status" "PositionStatus" NOT NULL DEFAULT 'unknown',
    "lastAlertStatus" "PositionStatus",
    "lastCheckedAt" TIMESTAMP(3),
    "raw" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Position_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'running',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "fromBlock" BIGINT,
    "toBlock" BIGINT,
    "transactionsSeen" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,

    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramEvent" (
    "id" TEXT NOT NULL,
    "positionId" TEXT,
    "alertType" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB,

    CONSTRAINT "TelegramEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Wallet_address_key" ON "Wallet"("address");

-- CreateIndex
CREATE INDEX "Transaction_walletId_blockNumber_idx" ON "Transaction"("walletId", "blockNumber");

-- CreateIndex
CREATE INDEX "Transaction_type_idx" ON "Transaction"("type");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_walletId_hash_key" ON "Transaction"("walletId", "hash");

-- CreateIndex
CREATE INDEX "Position_status_idx" ON "Position"("status");

-- CreateIndex
CREATE UNIQUE INDEX "Position_walletId_tokenId_key" ON "Position"("walletId", "tokenId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramEvent_dedupeKey_key" ON "TelegramEvent"("dedupeKey");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Position" ADD CONSTRAINT "Position_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "Wallet"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramEvent" ADD CONSTRAINT "TelegramEvent_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "Position"("id") ON DELETE SET NULL ON UPDATE CASCADE;
