/**
 * verify 逐阶段日志留痕（2026-11-12，偶发红排查用）。
 *
 * 背景：跨套件偶发红只有 `✗ 5 项失败` 这类汇总行时无法复盘；上一轮虽然把
 * 失败阶段的输出末尾 8000 字符塞进 .verify-report.json，但成功阶段的输出、
 * 命令/退出码/signal/spawn 错误、以及多轮之间的对照都丢了。
 *
 * 本模块只负责「写日志」，不改任何判定逻辑：
 *  - 每轮一个目录 `.verify-logs/<runId>/`（可用 --log-dir 覆盖）；
 *  - 每个阶段一份完整 stdout+stderr，文件头附命令、cwd、退出码、signal、耗时；
 *  - 轮末写 `index.json`（阶段顺序 + 结论 + 日志文件名），便于脚本化比对多轮。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

/** @param {string} root 项目根目录 @param {{dir?:string}} opts */
export function createLogSession(root, opts = {}) {
  const runId = `${new Date().toISOString().replace(/[:.]/g, '-')}-p${process.pid}`;
  const base = opts.dir ? resolve(opts.dir) : resolve(root, '.verify-logs', runId);
  mkdirSync(base, { recursive: true });
  const entries = [];
  let seq = 0;

  return {
    runId,
    base,
    /** 写一个阶段的完整日志，返回绝对路径。 */
    write(stage, { code, out, ms, signal, error, timedOut }) {
      seq += 1;
      const safeId = String(stage.id).replace(/[^A-Za-z0-9_.-]/g, '_');
      const file = `${String(seq).padStart(2, '0')}_${safeId}.log`;
      const header = [
        `runId      : ${runId}`,
        `stage      : ${stage.id} - ${stage.name}`,
        `cwd        : ${stage.cwd}`,
        `cmd        : ${[stage.cmd, ...(stage.args ?? [])].join(' ')}`,
        `exitCode   : ${code}`,
        `signal     : ${signal ?? 'none'}`,
        `timedOut   : ${timedOut === true}`,
        `spawnError : ${error ?? 'none'}`,
        `elapsedMs  : ${ms}`,
        '---------------- output ----------------',
      ].join('\n');
      const path = join(base, file);
      writeFileSync(path, `${header}\n${out ?? ''}\n`, 'utf8');
      entries.push({ seq, id: stage.id, name: stage.name, code, ms, file, signal: signal ?? null, timedOut: !!timedOut });
      return path;
    },
    /** 轮末索引：多轮复现时可直接 diff 两个 index.json。 */
    writeIndex(extra = {}) {
      const path = join(base, 'index.json');
      writeFileSync(path, `${JSON.stringify({ runId, ...extra, stages: entries }, null, 2)}\n`, 'utf8');
      return path;
    },
  };
}
