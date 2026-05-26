CREATE TABLE "RebalancePlan" (
    "id" TEXT NOT NULL,
    "planKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mode" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "telegramChatId" TEXT,
    "telegramMessageId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RebalancePlan_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "RebalancePlan_planKey_status_idx" ON "RebalancePlan"("planKey", "status");
CREATE INDEX "RebalancePlan_status_createdAt_idx" ON "RebalancePlan"("status", "createdAt");
