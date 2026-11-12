# SQLite 迁移链归档（P5-1 W1，2026-11-12）

这 11 条是 2026-11-03 ~ 2026-11-10 期间的 SQLite 迁移，W1 切 Postgres 时**整体移出**
`prisma/migrations/`（Prisma 只扫描该目录），留档备查，不再参与 `migrate deploy`。

## 为什么不是「加第 12 条迁移」

- 全链为 SQLite 方言：`AUTOINCREMENT`、`DROP COLUMN`、`DATETIME`、`PRAGMA` 等，
  在 Postgres 上无法执行；原 `migration_lock.toml` 也锁 `sqlite`。
- `schema.prisma` 顶部原注释「改 provider 即可」是错的，已在 W1 订正。
- 项目无真实老用户，按既定口径「不留兼容后门 / 旧链路」，采用**停机一次性切换**：
  归档旧链 → lock 重置为 `postgresql` → 用一条 PG 基线 `20261112123700_init` 重建，
  由 `npx prisma migrate diff --from-empty --to-schema-datamodel` 生成，纯 PG 方言。

## 数据

- `Save.revision` 原先藏在 `authority` JSON 里，W1 随基线提为独立列（INTEGER NOT NULL DEFAULT 0）。
- 停机回填脚本：`backend/prisma/backfill_revision.sql`（按 authority 里的 revision 原值回填，
  **不重编号、不 +1**；null / 坏 JSON 给 0）。新库为空时执行结果为 0 行。
- 本机旧 `backend/prisma/dev.db` 仅作回滚兜底保留，不在版本库内，也不再被应用读取。

## 注意

PG 迁移链单向、不回滚；若基线需要修补，用**新的前向迁移**，不要改这份归档。
实施设计与 12 处勘误见 `.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md` §1 / §4.2 W1。
