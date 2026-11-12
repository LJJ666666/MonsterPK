-- P4-1a 顶号：账号登录代次。默认值 0 保证既有账号不用停机迁移数据，
-- 下一次登录会由业务代码递增并写进 JWT 的 sv。
ALTER TABLE "User" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;
