// 存档结构版本（前后端共同契约）。
//
// 重要约定（新增/修改任何持久化字段时必须遵守）：
//   1. 递增下方 SCHEMA_VERSION（数字）；
//   2. 后端 `backend/src/lib/saveValidator.ts` 的 EXPECTED_SAVE_VERSION 同步修改；
//   3. 服务端落库的存档在 `commitState` 前会做结构校验，版本不符直接拒绝。
//
// P5 起前端不再持有存档副本，早年的 `migrateSaveState`（v1→v11 的逐级补字段）
// 只为 localStorage 里的老档服务，随本地存档一起删除。迁移职责现在只在服务端一侧：
// 结构不合法的存档根本进不了库，能进库的一定是当前版本。
export const SCHEMA_VERSION = 11;

/** 写入 SaveData 内部的版本字段（字符串，便于 importSaveJson 做 typeof 校验）。 */
export const SAVE_VERSION = String(SCHEMA_VERSION);
