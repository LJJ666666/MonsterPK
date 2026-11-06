/**
 * 「新建/重置存档」标记（P1-2-d）。
 *
 * 独立成零依赖模块，避免 useGameStore ↔ sync 形成顶层循环导入：
 * store 调 markRebase()，自动同步在下一次 PUT 时 takeRebase() 把标记带给服务端，
 * 服务端校验「新档特征」后重建权威基线。
 */
let rebaseNext = false;

export function markRebase(): void {
  rebaseNext = true;
}

export function takeRebase(): boolean {
  const v = rebaseNext;
  rebaseNext = false;
  return v;
}
