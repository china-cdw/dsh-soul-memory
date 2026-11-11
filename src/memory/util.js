// dsh-x-memory — 自建五层共用的底层工具
//
// 为什么要单独一个目录：src/ 下其余 27 个文件是 dsh-soul 2.0.1 的逐字节镜像，
// 升级上游时会整体覆盖 src/*.js。本插件自己写的模块（core-memory / persona /
// coding / lessons）和它们的公共底座都放在 src/memory/ 下，sync-upstream 只覆盖
// 其余文件，不会误删这里。
//
// 这里只放五层真正重复的东西：路径、原子写、写串行化、敏感信息过滤；不引入新依赖。

import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * 凭据形状：只认 key:value / key=value（值 ≥6 字符），裸词不算。
 * 历史版本把裸词（token/password）整行删掉，导致 "SyntaxError: Unexpected token '<'"
 * 这类最常见的 JS 语法错误被当成敏感行丢弃、永远进不了记忆。
 */
export const SECRET_PATTERN = /(?:password|passwd|secret|token|api[-_ ]?key|access[-_ ]?key|bearer|authorization)\s*[:=]\s*\S{6,}/i;

const SECRET_VALUE = /((?:password|passwd|secret|token|api[-_ ]?key|access[-_ ]?key|bearer|authorization)\s*[:=]\s*)([^\s'"]{6,})/gi;

/** 按字符位置截断，不切断 emoji 等代理对（切一半会留下孤立 \ud83d）。 */
export function sliceSafe(text, end) {
  const s = String(text ?? '');
  if (end <= 0) return '';
  if (s.length <= end) return s;
  let cut = end;
  const code = s.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
}

/** 截断并补省略号：展示用，保证总长不超过 max。 */
export function bounded(text, max) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return sliceSafe(s, Math.max(0, max - 1)) + '…';
}

/** DSH home：与宿主保持一致，允许用环境变量覆盖（测试与多 profile 场景）。 */
export function memoryHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

/** <dshHome>/memory/ 下的路径。 */
export function memoryPath(...parts) {
  return join(memoryHome(), 'memory', ...parts);
}

/**
 * 写临时文件再 rename，避免读到半截内容。
 * 临时名带 pid + 毫秒 + 随机后缀：同一毫秒内两个进程/两次写入也不会撞名；
 * 写入或 rename 失败时清掉临时文件，不在记忆目录里留垃圾。
 */
export async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  try {
    await writeFile(tmp, content, 'utf8');
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** 串行化写入：同进程多个 agent 并发写同一份文件时按提交顺序落盘。 */
export function createQueue() {
  let tail = Promise.resolve();
  return function enqueue(job) {
    const run = tail.then(job, job);
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** JSON.parse 的统一包装：坏 JSON 返回 fallback，调用方不必再嵌套 try。 */
export function safeJson(raw, fallback = null) {
  try {
    const parsed = JSON.parse(raw);
    return parsed === undefined ? fallback : parsed;
  } catch {
    return fallback;
  }
}

/** 掩码凭据值并截断；用于错误文本、命令、笔记片段。不再整行丢弃。 */
export function redactSecrets(text, limit = 600) {
  return sliceSafe(String(text ?? '').replace(SECRET_VALUE, '$1[REDACTED]'), limit);
}

/** 统一的失败文案。 */
export function errText(e) {
  return '操作失败：' + (e && e.message ? e.message : String(e));
}

const SNAPSHOT_FILES = ['MEMORY.md', 'PERSONA.md', 'CODING.md', 'LESSONS.jsonl', 'index.json'];

/**
 * 每日快照：把记忆文件拷到 <memory>/.snapshots/<时间戳>/，保留最近 keep 份。
 * 同一天只做一次；任何一步失败都只跳过，不影响正常读写。
 * 一份都没拷到（记忆目录还是空的 / 权限问题）时删掉空目录并返回 error，
 * 否则快照列表里会出现一堆空目录，体检和轮转都会被它们污染。
 */
export async function snapshotMemory({ keep = 7 } = {}) {
  const dir = memoryPath('.snapshots');
  await mkdir(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  let names = [];
  try { names = await readdir(dir); } catch { names = []; }
  if (names.some((n) => n.startsWith(today))) return { skipped: true, dir, count: names.length };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dest = join(dir, stamp);
  await mkdir(dest, { recursive: true });
  let copied = 0;
  for (const name of SNAPSHOT_FILES) {
    try { await copyFile(memoryPath(name), join(dest, name)); copied++; } catch { /* 文件不存在就跳过 */ }
  }
  try {
    await cp(memoryPath('notes'), join(dest, 'notes'), { recursive: true });
    copied++;
  } catch { /* 没有 notes 目录就跳过 */ }
  if (copied === 0) {
    await rm(dest, { recursive: true, force: true }).catch(() => {});
    return { skipped: false, dir: dest, copied: 0, error: '没有可快照的记忆文件（记忆目录为空或不可读）' };
  }
  await rotateSnapshots(dir, keep);
  return { skipped: false, dir: dest, copied };
}

/** 按目录 mtime 轮转：时间戳目录名在跨时区/手工改名时不一定有序，mtime 更可靠。 */
async function rotateSnapshots(dir, keep) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  const dirs = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (st.isDirectory()) dirs.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* 读不到就不参与轮转 */ }
  }
  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const old of dirs.slice(0, Math.max(0, dirs.length - keep))) {
    await rm(join(dir, old.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** 最近一次快照信息，读不到就返回 null。 */
export async function latestSnapshot() {
  const dir = memoryPath('.snapshots');
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  const dirs = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (st.isDirectory()) dirs.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* 忽略 */ }
  }
  if (!dirs.length) return null;
  dirs.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const last = dirs[dirs.length - 1];
  return { name: last.name, count: dirs.length };
}
