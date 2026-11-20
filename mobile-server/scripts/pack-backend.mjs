#!/usr/bin/env node
/**
 * mobile-server：打包后端交付物（源码 + prisma + package.json，不含 node_modules）。
 * 纯 Node 实现 tar.gz（不依赖外部 tar，规避 Windows 盘符冒号问题）。
 * 产物 output/backend-src.tar.gz 供 adb push 进手机，在 proot Debian 内 npm install。
 * 主工程 backend/ 零改动（只读复制）。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const msDir = path.resolve(here, '..');
const repo = path.resolve(msDir, '..');
const backend = path.join(repo, 'backend');
const outTar = path.join(msDir, 'output/backend-src.tar.gz');

// 内存文件表：{ name: tar内相对路径, data: Buffer }
const files = [];
function walk(abs, rel) {
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    for (const n of fs.readdirSync(abs)) walk(path.join(abs, n), rel ? `${rel}/${n}` : n);
  } else {
    files.push({ name: rel, data: fs.readFileSync(abs) });
  }
}
for (const name of ['src', 'prisma', 'scripts']) {
  const s = path.join(backend, name);
  if (fs.existsSync(s)) walk(s, name);
}
for (const name of ['package.json', 'package-lock.json', 'tsconfig.json']) {
  const s = path.join(backend, name);
  if (fs.existsSync(s)) files.push({ name, data: fs.readFileSync(s) });
}
// .env：连接串改为容器内 127.0.0.1。
const envSrc = path.join(backend, '.env');
if (fs.existsSync(envSrc)) {
  const env = fs.readFileSync(envSrc, 'utf8')
    .replace(/DATABASE_URL=.*/g, 'DATABASE_URL="postgresql://mpk@127.0.0.1:5432/monsterpk?schema=public"')
    .replace(/^#?\s*REDIS_URL=.*/gm, 'REDIS_URL="redis://127.0.0.1:6379"')
    .replace(/CORS_ORIGIN=.*/g, 'CORS_ORIGIN="http://localhost"')
    .replace(/JWT_SECRET=.*/g, 'JWT_SECRET="mobile-server-local-only-change-me-please"');
  files.push({ name: '.env', data: Buffer.from(env, 'utf8') });
}

// tar header（ustar）：512B/文件，数据补零到 512 倍数。
function tarHeader(name, size) {
  const h = Buffer.alloc(512, 0);
  const put = (s, off, len) => Buffer.from(s, 'utf8').copy(h, off, 0, len);
  put(name, 0, 100);
  put('0000644\0', 100, 8);
  put('0000000\0', 108, 8);
  put('0000000\0', 116, 8);
  put(size.toString(8).padStart(11, '0') + '\0', 124, 12);
  put('00000000000\0', 136, 12);
  put('ustar\0', 257, 6);
  put('00', 263, 2);
  // checksum：按 POSIX ustar，校验和字段(148..155)先填 8 个空格再逐字节求和，
  // 之后写回 6 位八进制 + NUL + 空格。之前只置 h[148]='0'、其余留 0 导致 checksum 错误，
  // 任何标准 tar 解压都报 "bad checksum"。
  h.fill(0x20, 148, 156);
  let sum = 0; for (const b of h) sum += b;
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
const chunks = [];
for (const f of files) {
  chunks.push(tarHeader(f.name, f.data.length));
  chunks.push(f.data);
  const pad = (512 - (f.data.length % 512)) % 512;
  if (pad) chunks.push(Buffer.alloc(pad, 0));
}
chunks.push(Buffer.alloc(1024, 0)); // EOF
const tarbuf = Buffer.concat(chunks);
fs.mkdirSync(path.dirname(outTar), { recursive: true });
fs.writeFileSync(outTar, zlib.gzipSync(tarbuf));
console.log(`[mobile-server] backend 源码包: ${outTar} (${(fs.statSync(outTar).size/1048576).toFixed(2)} MB, ${files.length} files)`);
