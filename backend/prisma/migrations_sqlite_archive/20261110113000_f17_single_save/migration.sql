-- F17 单档化（2026-11-10）：删三档，一账号一档，所有表移除 slot 列。
-- 前提：改 schema 前已停 :3001 释放 Prisma DLL；SQLite >= 3.35 支持 DROP COLUMN。
-- 口径：每个 userId 只保留一条存档（优先 slot=1，否则 latest updatedAt），
--       避免「只有 slot=2/3 一档」的账号被整条删掉；其余表按新唯一键去重。
-- 索引名必须与 schema.prisma 的 @unique / @@index 推导名一致，否则 migrate 后 drift。

-- 1) 清理会在「去掉 slot 后的新唯一键」上冲突的重复行。
DELETE FROM "Save" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (
      PARTITION BY "userId"
      ORDER BY CASE WHEN "slot" = 1 THEN 0 ELSE 1 END, "updatedAt" DESC
    ) AS rn FROM "Save"
  ) WHERE rn > 1
);
DELETE FROM "IntentLog" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "userId", "nonce" ORDER BY "id") AS rn
    FROM "IntentLog"
  ) WHERE rn > 1
);
DELETE FROM "RankReward" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "periodKey", "boardKey", "userId" ORDER BY "id") AS rn
    FROM "RankReward"
  ) WHERE rn > 1
);
DELETE FROM "CoopRewardGrant" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", ROW_NUMBER() OVER (PARTITION BY "roomId", "userId" ORDER BY "id") AS rn
    FROM "CoopRewardGrant"
  ) WHERE rn > 1
);

-- 2) 先删引用 slot 的旧索引（SQLite 的 DROP COLUMN 不允许列仍被索引引用）。
DROP INDEX IF EXISTS "Save_userId_slot_key";
DROP INDEX IF EXISTS "IntentLog_userId_slot_createdAt_idx";
DROP INDEX IF EXISTS "IntentLog_userId_slot_nonce_key";
DROP INDEX IF EXISTS "RankReward_periodKey_boardKey_userId_slot_key";
DROP INDEX IF EXISTS "CoopRewardGrant_roomId_userId_slot_key";
DROP INDEX IF EXISTS "CoopRewardGrant_userId_slot_periodKey_idx";

-- 3) 删列（历史 grantKey 字符串里残留的 :<slot> 只是审计值，不改写，防重语义不变）。
ALTER TABLE "BanRecord" DROP COLUMN "slot";
ALTER TABLE "Save" DROP COLUMN "slot";
ALTER TABLE "IntentLog" DROP COLUMN "slot";
ALTER TABLE "BossDamageEvent" DROP COLUMN "slot";
ALTER TABLE "RankReward" DROP COLUMN "slot";
ALTER TABLE "BossRewardGrant" DROP COLUMN "slot";
ALTER TABLE "CoopRewardGrant" DROP COLUMN "slot";

-- 4) 按新 schema 重建唯一键与索引。
CREATE UNIQUE INDEX "Save_userId_key" ON "Save"("userId");
CREATE UNIQUE INDEX "IntentLog_userId_nonce_key" ON "IntentLog"("userId", "nonce");
CREATE INDEX "IntentLog_userId_createdAt_idx" ON "IntentLog"("userId", "createdAt");
CREATE UNIQUE INDEX "RankReward_periodKey_boardKey_userId_key" ON "RankReward"("periodKey", "boardKey", "userId");
CREATE UNIQUE INDEX "CoopRewardGrant_roomId_userId_key" ON "CoopRewardGrant"("roomId", "userId");
CREATE INDEX "CoopRewardGrant_userId_periodKey_idx" ON "CoopRewardGrant"("userId", "periodKey");
