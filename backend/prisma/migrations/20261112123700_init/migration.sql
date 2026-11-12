-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'player',
    "bannedAt" TIMESTAMP(3),
    "banReason" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BanRecord" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codes" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "stats" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BanRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Save" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "data" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL DEFAULT 'unknown',
    "clientId" TEXT,
    "authority" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Save_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntentLog" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntentLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BossDamageEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "bossId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "damage" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BossDamageEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankPeriodSnapshot" (
    "id" SERIAL NOT NULL,
    "periodKey" TEXT NOT NULL,
    "boardKey" TEXT NOT NULL,
    "entries" TEXT NOT NULL,
    "eligible" INTEGER NOT NULL DEFAULT 0,
    "skipped" INTEGER NOT NULL DEFAULT 0,
    "settledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankPeriodSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RankReward" (
    "id" SERIAL NOT NULL,
    "periodKey" TEXT NOT NULL,
    "boardKey" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL,
    "reward" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RankReward_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BossRewardGrant" (
    "id" SERIAL NOT NULL,
    "userId" TEXT NOT NULL,
    "bossId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "tier" TEXT NOT NULL,
    "grantKey" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,
    "reward" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BossRewardGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CoopRewardGrant" (
    "id" SERIAL NOT NULL,
    "roomId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "contribution" INTEGER NOT NULL DEFAULT 0,
    "grantKey" TEXT NOT NULL,
    "reward" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CoopRewardGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BadgeGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BadgeGrant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AchievementGrant" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AchievementGrant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE INDEX "BanRecord_userId_createdAt_idx" ON "BanRecord"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Save_userId_key" ON "Save"("userId");

-- CreateIndex
CREATE INDEX "IntentLog_userId_createdAt_idx" ON "IntentLog"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IntentLog_userId_nonce_key" ON "IntentLog"("userId", "nonce");

-- CreateIndex
CREATE UNIQUE INDEX "BossDamageEvent_battleId_key" ON "BossDamageEvent"("battleId");

-- CreateIndex
CREATE INDEX "BossDamageEvent_bossId_periodKey_damage_idx" ON "BossDamageEvent"("bossId", "periodKey", "damage");

-- CreateIndex
CREATE INDEX "BossDamageEvent_userId_bossId_periodKey_idx" ON "BossDamageEvent"("userId", "bossId", "periodKey");

-- CreateIndex
CREATE INDEX "RankPeriodSnapshot_periodKey_idx" ON "RankPeriodSnapshot"("periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "RankPeriodSnapshot_periodKey_boardKey_key" ON "RankPeriodSnapshot"("periodKey", "boardKey");

-- CreateIndex
CREATE INDEX "RankReward_userId_grantedAt_idx" ON "RankReward"("userId", "grantedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RankReward_periodKey_boardKey_userId_key" ON "RankReward"("periodKey", "boardKey", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "BossRewardGrant_grantKey_key" ON "BossRewardGrant"("grantKey");

-- CreateIndex
CREATE INDEX "BossRewardGrant_userId_periodKey_idx" ON "BossRewardGrant"("userId", "periodKey");

-- CreateIndex
CREATE INDEX "BossRewardGrant_bossId_periodKey_idx" ON "BossRewardGrant"("bossId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "CoopRewardGrant_grantKey_key" ON "CoopRewardGrant"("grantKey");

-- CreateIndex
CREATE INDEX "CoopRewardGrant_userId_periodKey_idx" ON "CoopRewardGrant"("userId", "periodKey");

-- CreateIndex
CREATE UNIQUE INDEX "CoopRewardGrant_roomId_userId_key" ON "CoopRewardGrant"("roomId", "userId");

-- CreateIndex
CREATE INDEX "BadgeGrant_userId_grantedAt_idx" ON "BadgeGrant"("userId", "grantedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BadgeGrant_userId_badgeId_key" ON "BadgeGrant"("userId", "badgeId");

-- CreateIndex
CREATE INDEX "AchievementGrant_userId_grantedAt_idx" ON "AchievementGrant"("userId", "grantedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AchievementGrant_userId_achievementId_key" ON "AchievementGrant"("userId", "achievementId");

-- AddForeignKey
ALTER TABLE "BanRecord" ADD CONSTRAINT "BanRecord_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Save" ADD CONSTRAINT "Save_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

