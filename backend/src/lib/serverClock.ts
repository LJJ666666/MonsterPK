/**
 * 服务端时钟钳制（P1-1b）。
 *
 * 对应需求：「不允许修改系统时间获取资源，但不涉及封号，只是不生效就行」。
 * 处理方式：**不拒绝、不封号、不告警**，直接把客户端上报的未来时间戳改写为服务器时间。
 * 这样改系统时间拿不到任何额外收益，也无法让本地存档凭未来时间永远赢
 * P0-3 的 last-write-wins 冲突决策（这是原 P1-1 把它判成硬违规的理由）。
 *
 * ⚠️ 能力边界：本模块解决「把时间往未来调」。把时间往过去调以刷挂机收益，
 * 必须等 P1-2 把挂机结算上移服务端（服务端自己记录 startedAt、按服务端时钟算 delta）
 * 才能根治——客户端写 startedAt 时，客户端时钟永远不可信。
 */
import { SAVE_LIMITS } from './saveValidator';

export type ClampResult = {
  /** 钳制后的存档 JSON 文本；无改动时原样返回（避免无谓的重新序列化）。 */
  data: string;
  /** 被改写的字段路径，供结构化日志留痕。 */
  adjusted: string[];
};

/**
 * 把存档里的未来时间戳钳制为服务端当前时间。
 * @param raw 客户端上报的存档 JSON 文本
 * @param now 服务端时钟（毫秒），便于单测注入
 */
export function clampSaveTimestamps(raw: string, now: number = Date.now()): ClampResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // 非法 JSON 交由 saveValidator 拒绝，这里不重复处理
    return { data: raw, adjusted: [] };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { data: raw, adjusted: [] };
  }

  const root = parsed as Record<string, any>;
  const serverIso = new Date(now).toISOString();
  const adjusted: string[] = [];

  /** 只钳制「明显晚于服务器」的时间；允许正常时钟偏差，避免误伤。 */
  const fix = (holder: Record<string, any>, key: string, path: string): void => {
    const value = holder[key];
    if (typeof value !== 'string') return;
    const t = Date.parse(value);
    if (!Number.isFinite(t)) return; // 非法时间字符串交由 validator 记兼容告警
    if (t > now + SAVE_LIMITS.CLOCK_SKEW_MS) {
      holder[key] = serverIso;
      adjusted.push(path);
    }
  };

  fix(root, 'lastSavedAt', 'lastSavedAt');
  if (root.idle && typeof root.idle === 'object' && !Array.isArray(root.idle)) {
    fix(root.idle, 'startedAt', 'idle.startedAt');
  }

  if (adjusted.length === 0) return { data: raw, adjusted: [] };
  return { data: JSON.stringify(root), adjusted };
}
