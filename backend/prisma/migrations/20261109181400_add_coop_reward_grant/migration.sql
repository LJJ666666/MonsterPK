-- F16 共斗六房副本通关奖励发放记录
-- CreateTable
CREATE TABLE "CoopRewardGrant" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "periodKey" TEXT NOT NULL,
    "contribution" INTEGER NOT NULL DEFAULT 0,
    "grantKey" TEXT NOT NULL,
    "reward" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "CoopRewardGrant_grantKey_key" ON "CoopRewardGrant"("grantKey");

-- CreateIndex
CREATE UNIQUE INDEX "CoopRewardGrant_roomId_userId_slot_key" ON "CoopRewardGrant"("roomId", "userId", "slot");

-- CreateIndex
CREATE INDEX "CoopRewardGrant_userId_slot_periodKey_idx" ON "CoopRewardGrant"("userId", "slot", "periodKey");
