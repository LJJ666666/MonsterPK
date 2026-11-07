-- P4-2c：Boss 伤害事件（append-only）
-- 一行 = 一次有效讨伐的结算结果；battleId 唯一保证同一场战斗不会重复计入。
-- 每日次数真值 = 本表该用户当日该 Boss 的行数（内存只记在途 hold）。
CREATE TABLE "BossDamageEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "slot" INTEGER NOT NULL,
    "bossId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "damage" INTEGER NOT NULL,
    "result" TEXT NOT NULL,
    "battleId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX "BossDamageEvent_battleId_key" ON "BossDamageEvent"("battleId");
CREATE INDEX "BossDamageEvent_bossId_periodKey_damage_idx" ON "BossDamageEvent"("bossId", "periodKey", "damage");
CREATE INDEX "BossDamageEvent_userId_bossId_periodKey_idx" ON "BossDamageEvent"("userId", "bossId", "periodKey");
