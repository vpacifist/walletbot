CREATE TABLE "HistoricalTokenPrice" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "blockNumber" BIGINT NOT NULL,
    "priceUsd" DECIMAL(30,12),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HistoricalTokenPrice_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "HistoricalTokenPrice_token_blockNumber_key" ON "HistoricalTokenPrice"("token", "blockNumber");
CREATE INDEX "HistoricalTokenPrice_token_idx" ON "HistoricalTokenPrice"("token");
