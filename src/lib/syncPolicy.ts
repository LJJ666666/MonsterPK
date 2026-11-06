// 存档冲突决策（纯函数，不依赖网络 / store / localStorage，便于单测）。
export type SyncDecision = "restore" | "upload" | "none";

/**
 * 根据本地/云端有无 + 时间戳 + 是否同设备，决定冲突处理动作：
 * - 任一侧为空：空的一侧服从有的一侧（恢复或上传基线）；
 * - 两侧都有且是同一台设备：以本地为准回传云端；
 * - 跨设备：谁的时间戳新，谁赢（last-write-wins）。
 */
export function decideSyncAction(opts: {
  localExists: boolean;
  localTime: number; // 毫秒
  cloudExists: boolean;
  cloudTime: number; // 毫秒
  sameDevice: boolean;
}): SyncDecision {
  const { localExists, localTime, cloudExists, cloudTime, sameDevice } = opts;
  if (!localExists && !cloudExists) return "none";
  if (!localExists && cloudExists) return "restore";
  if (localExists && !cloudExists) return "upload";
  // 两端都有存档
  if (sameDevice) return "upload"; // 同一台设备：本地即权威，回传云端
  return cloudTime > localTime ? "restore" : "upload"; // 跨设备：新者胜
}
