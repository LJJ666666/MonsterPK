-- CreateTable
CREATE TABLE "RankPeriodSnapshot" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "periodKey" TEXT NOT NULL,
    "boardKey" TEXT NOT NULL,
    "entries" TEXT NOT NULL,
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "settledAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "RankReward" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "periodKey" TEXT NOT NULL,
    "boardKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "rank" INTEGER NOT NULL,
    "reward" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "RankPeriodSnapshot_periodKey_idx" ON "RankPeriodSnapshot"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "RankPeriodSnapshot_periodKey_boardKey_key" ON "RankPeriodSnapshot"("periodKey", "boardKey");

-- CreateIndex
CREATE INDEX "RankReward_userId_grantedAt_idx" ON "RankReward"("userId", "grantedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RankReward_periodKey_boardKey_userId_slot_key" ON "RankReward"("periodKey", "boardKey", "userId", "slot");
