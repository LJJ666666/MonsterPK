/**
 * headless Edge `--dump-dom` 的有限重试包装（2026-11-12 偶发红加固）。
 *
 * 现象：连续多轮全量验收时，`ui_smoke_p42d.mjs` 的 `seed 注入登录态` 曾拿到
 * Chromium 网络错误页（`<html dir="ltr" lang="zh">…` 而不是 seed 页），随后
 * iframe 里的应用没有登录态，探针停在登录页并连锁 11 项失败；前后 14 个冒烟
 * 全绿、单独重跑也全绿 —— 属 headless Edge 单次导航失败，不是产品 bug。
 *
 * 做法：只包装 `--dump-dom` 调用，输出是 Chromium 错误页或执行抛异常时**最多重试
 * 3 次**（后续尝试换一个 `--user-data-dir`，避免上次进程未完全释放）。断言逻辑
 * 完全不变：如果前端真的挂了，3 次后仍返回错误页，该红还是红，不掩盖问题。
 *
 * 15 个 `scripts/ui_smoke_*.mjs` 的 `runEdge()` 都只调用 `execFileSync(EDGE, args, opts)`，
 * 因此只需把 import 别名为 `rawExecFileSync` 并用本函数生成同名 `execFileSync`，
 * 无需逐个改函数体。非 `--dump-dom` 调用直接透传。
 */

const MAX_ATTEMPTS = 3;

/** Chromium 的网络错误页特征；项目自身的 seed / probe / index.html 都不长这样。 */
function isChromiumErrorPage(dom) {
  if (typeof dom !== 'string') return false;
  const head = dom.slice(0, 600);
  return /<html[^>]*\bdir="ltr"/i.test(head)
    || /<title>[^<]*(无法访问|出了点问题|ERR_)/i.test(head);
}

/** 给重试换一个独立的用户数据目录，避免上一次 Edge 进程尚未释放 profile。 */
function argsForAttempt(args, attempt) {
  if (attempt === 0) return args;
  return args.map((a) => (
    typeof a === 'string' && a.startsWith('--user-data-dir=') ? `${a}-retry${attempt}` : a
  ));
}

/** 最后一次尝试不再说「重试」，避免日志里出现「重试 3/2」这种误导。 */
function reportAttempt(attempt, why) {
  if (attempt < MAX_ATTEMPTS - 1) {
    console.error(`[RETRY] headless Edge ${why}，重试 ${attempt + 1}/${MAX_ATTEMPTS - 1}`);
  } else {
    console.error(`[RETRY_EXHAUSTED] headless Edge ${why}，已达上限，原样返回由断言裁决`);
  }
}

/**
 * @param {(file: string, args: string[], opts: object) => string} raw 原始 execFileSync
 * @returns 同签名的包装函数
 */
export function createRetriedExec(raw) {
  return function execFileSync(file, args, opts) {
    if (!Array.isArray(args) || !args.includes('--dump-dom')) {
      return raw(file, args, opts);
    }
    let last;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        const dom = raw(file, argsForAttempt(args, attempt), opts);
        if (!isChromiumErrorPage(dom)) return dom;
        last = dom;
        reportAttempt(attempt, '返回 Chromium 错误页');
      } catch (e) {
        last = e;
        reportAttempt(attempt, `执行异常：${String(e?.message ?? e).slice(0, 120)}`);
      }
    }
    if (last instanceof Error) throw last;
    return last;
  };
}
