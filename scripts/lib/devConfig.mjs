/**
 * 本机开发端口的单一真值源（W0 前置整理）。
 *
 * 背景：前端 dev 端口原先硬编码在 14 个 UI 冒烟脚本、verify 探活、CORS 默认值里，
 * 一旦某个本机端口被别的程序占用（实测微信 Weixin.exe 会把 0.0.0.0:5173 绑成
 * 出站源端口），只改启动命令会让整套 verify 假红。
 *
 * 约定：
 *   - 默认 5173，跨机器 / CI 零变更；
 *   - 需要换端口时，只需在**启动服务与跑 verify 的同一个 shell**里设 MPK_FRONT_PORT，
 *     前端脚本、探活、报错文案会一起跟着走；
 *   - backend/tests 属于另一个 npm 包，不跨包 import，各自读同名 env（口径一致）。
 *
 * 用法：MPK_FRONT_PORT=5174 npm run dev
 *       MPK_FRONT_PORT=5174 npm run verify -- --strict
 */
const raw = process.env.MPK_FRONT_PORT ?? '5173';
const parsed = Number(raw);

export const FRONT_PORT = Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : 5173;
export const FRONT_ORIGIN = `http://localhost:${FRONT_PORT}`;
export const FRONT_BASE = FRONT_ORIGIN;
export const FRONT_PROBE = `http://127.0.0.1:${FRONT_PORT}/`;
