-- F04 召唤师等级 / 徽章 / 成就（2026-11-10，规范 §31.5）
-- 账号级真值，不按 slot（F17 单档化铺路）；不写 SaveData、不动 SCHEMA_VERSION。
-- @@unique 天然幂等：重复发放 / 重复首通被 P2002 挡下，无需应用层锁
-- （调用链可能在战斗结算的 slotLock 内，见 bug_log §36 同锁重入死锁）。

CREATE TABLE "BadgeGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "badgeId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "BadgeGrant_userId_badgeId_key" ON "BadgeGrant"("userId", "badgeId");
CREATE INDEX "BadgeGrant_userId_grantedAt_idx" ON "BadgeGrant"("userId", "grantedAt");

CREATE TABLE "AchievementGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "achievementId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "grantedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "AchievementGrant_userId_achievementId_key" ON "AchievementGrant"("userId", "achievementId");
CREATE INDEX "AchievementGrant_userId_grantedAt_idx" ON "AchievementGrant"("userId", "grantedAt");
