-- CreateTable
CREATE TABLE "BossRewardGrant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "userId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "bossId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "grantKey" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,
    "reward" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "BossRewardGrant_grantKey_key" ON "BossRewardGrant"("grantKey");

-- CreateIndex
CREATE INDEX "BossRewardGrant_userId_periodKey_idx" ON "BossRewardGrant"("userId", "periodKey");

-- CreateIndex
CREATE INDEX "BossRewardGrant_bossId_periodKey_idx" ON "BossRewardGrant"("bossId", "periodKey");
