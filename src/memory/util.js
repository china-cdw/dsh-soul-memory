// dsh-x-memory — 自建五层共用的底层工具
//
// 为什么要单独一个目录：src/ 下其余 27 个文件是 dsh-soul 2.0.1 的逐字节镜像，
// 升级上游时会整体覆盖 src/*.js。本插件自己写的模块（core-memory / persona /
// coding / lessons）和它们的公共底座都放在 src/memory/ 下，sync-upstream 只覆盖
// 其余文件，不会误删这里。
//
// 这里只放五层真正重复的东西：路径、原子写、写串行化、敏感信息过滤；不引入新依赖。

import { randomUUID } from 'node:crypto';
import { copyFile, cp, mkdir, readdir, rename, rm, stat, writeFile, open, utimes, readFile } from 'node:fs/promises';
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

/**
 * 跨进程文件锁：`<file>.lock` 用 wx 独占创建，超时/过期自清理。
 * 用于 MEMORY.md / CODING.md 这类「读-改-写」必须整体的文件——进程内队列
 * 挡不住第二个 DSH 实例，两个实例各读旧内容再写回会静默丢内容。
 */
export async function withFileLock(file, job, { waitMs = null, staleMs = 10000 } = {}) {
  const lock = file + '.lock';
  await mkdir(dirname(lock), { recursive: true });
  const token = process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const started = Date.now();
  // 显式 waitMs（调用方/环境变量）优先；未指定时按 stale 的 1.2 倍兜底，
  // 保证等待窗口大于过期阈值，避免两个进程同时判定对方过期并互相拆锁。
  const waitEnv = Number(process.env.DSH_X_MEMORY_LOCK_WAIT_MS);
  const effectiveWait = waitEnv > 0 ? waitEnv
    : Number.isFinite(waitMs) && waitMs > 0 ? waitMs
    : Math.max(10000, Math.ceil(staleMs * 1.2));
  for (;;) {
    try {
      await writeFile(lock, token, { flag: 'wx' });
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw e;
      if (Date.now() - started > effectiveWait) throw new Error('文件写入被占用（' + lock + ' 超过 ' + effectiveWait + 'ms 未释放）');
      try {
        // 删过期锁前必须复核内容：stat 与 rm 之间持有者可能刚换人，
        // 直接 rm 会把别人新建的有效锁删掉，两个写者同时进临界区。
        const before = await readFile(lock, 'utf8').catch(() => null);
        const st = await stat(lock);
        if (before !== null && Date.now() - st.mtimeMs > staleMs) {
          const again = await readFile(lock, 'utf8').catch(() => null);
          const st2 = await stat(lock);
          // 心跳只刷新 mtime、不改内容：内容相同但 mtime 前进了，说明持有者还活着。
          if (again === before && st2.mtimeMs === st.mtimeMs) await rm(lock, { force: true });
        }
      } catch { /* 锁刚被持有者删掉，睡一下再试 */ }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  // 心跳：读-改-写可能远超 staleMs（大文件查重），不刷新 mtime 会被别人当成过期锁删掉。
  const beat = setInterval(() => {
    readFile(lock, 'utf8')
      .then((held) => {
        if (held !== token) return undefined;
        const now = new Date();
        return utimes(lock, now, now);
      })
      .catch(() => {});
  }, Math.max(50, Math.floor(staleMs / 4)));
  beat.unref?.();
  try {
    return await job();
  } finally {
    clearInterval(beat);
    // 只删自己持有的锁：token 不一致说明锁被清理后又被别人抢到，删掉会误伤。
    try {
      const held = await readFile(lock, 'utf8');
      if (held === token) await rm(lock, { force: true });
    } catch { /* 锁已不在，无事可做 */ }
  }
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
    // fsync：断电/崩溃后 rename 成功但内容为空的情况，靠这一步避免。
    try {
      const fh = await open(tmp, 'r+');
      try { await fh.sync(); } finally { await fh.close(); }
    } catch { /* fsync 失败不阻断写入，但至少尝试过 */ }
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
  // 只在「今天已完成」时跳过：目录存在不代表拷完了——图谱快照（snapshotGraph）会先建当天目录，
  // 旧实现按目录名前缀判断，会把文件记忆的备份整个跳过去。
  const todayDirs = names.filter((n) => n.startsWith(today)).sort();
  for (const name of todayDirs) {
    try { await stat(join(dir, name, '.complete')); return { skipped: true, dir: join(dir, name), count: names.length }; } catch { /* 未完成，继续补 */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const createdNew = todayDirs.length === 0;
  const dest = createdNew ? join(dir, stamp) : join(dir, todayDirs[todayDirs.length - 1]);
  await mkdir(dest, { recursive: true });
  let copied = 0;
  const failed = [];
  for (const name of SNAPSHOT_FILES) {
    try {
      const st = await stat(memoryPath(name));
      if (!st.isFile()) continue;
      await copyFile(memoryPath(name), join(dest, name));
      copied++;
    } catch (e) {
      // ENOENT 表示这个文件本来就没有；其他错误（占用/权限）意味着当天备份不完整，不能写 .complete。
      if (e && e.code !== 'ENOENT') failed.push(name);
    }
  }
  try {
    await cp(memoryPath('notes'), join(dest, 'notes'), { recursive: true });
    copied++;
  } catch (e) {
    // ENOENT 表示本来没有 notes；其他错误意味着这天的备份不完整。
    if (e && e.code !== 'ENOENT') failed.push('notes');
  }
  if (copied === 0) {
    // 只删自己刚建的目录：复用当天已有目录时，里面可能有 snapshotGraph 写进的 evolve.sqlite，
    // 连带 rm 会把刚做好的图谱快照一起删掉。
    if (createdNew) await rm(dest, { recursive: true, force: true }).catch(() => {});
    return { skipped: false, dir: dest, copied: 0, error: '没有可快照的记忆文件（记忆目录为空或不可读）' };
  }
  // 完成标记：只有它存在才表示这一天的文件记忆真的备完了；有文件没拷成就先不写，
  // 下次启动会重试，轮转也不会把残缺备份当成好备份。
  if (!failed.length) {
    try {
      await writeFile(join(dest, '.complete'), new Date().toISOString(), 'utf8');
    } catch {
      failed.push('.complete');
      console.error('dsh-x-memory: 完成标记写入失败，本次快照按不完整处理。');
    }
  }
  else console.error('dsh-x-memory: 快照不完整，未写完成标记：' + failed.join(', '));
  await rotateSnapshots(dir, keep);
  return { skipped: false, dir: dest, copied, incomplete: failed };
}

/**
 * 把会话图谱库并入当天快照。用 SQLite 的 VACUUM INTO 生成一致副本，
 * 直接 copyFile 会把 WAL 里未 checkpoint 的内容漏掉。
 * 失败只跳过：图谱库打不开时文件记忆照常可用。
 */
export async function snapshotGraph(db, { keep = 7 } = {}) {
  if (!db || typeof db.exec !== 'function') return { skipped: true };
  const dir = memoryPath('.snapshots');
  await mkdir(dir, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  let target = names.filter((n) => n.startsWith(today)).sort().pop();
  if (!target) {
    target = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await mkdir(join(dir, target), { recursive: true });
  }
  const dest = join(dir, target, 'evolve.sqlite');
  try {
    await stat(dest);
    return { skipped: true, dir: join(dir, target) };
  } catch { /* 今天还没备份过，继续 */ }
  try {
    db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    await rotateSnapshots(dir, keep);
    return { skipped: false, dir: join(dir, target), copied: true };
  } catch (e) {
    return { skipped: true, error: e && e.message ? e.message : String(e) };
  }
}

/** 按目录 mtime 轮转：时间戳目录名在跨时区/手工改名时不一定有序，mtime 更可靠。 */
async function rotateSnapshots(dir, keep) {
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  const complete = [];
  const incomplete = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (!st.isDirectory()) continue;
      try {
        await stat(join(dir, name, '.complete'));
        complete.push({ name, mtimeMs: st.mtimeMs });
      } catch {
        incomplete.push({ name, mtimeMs: st.mtimeMs });
      }
    } catch { /* 读不到就不参与轮转 */ }
  }
  // 残缺备份优先淘汰：它们不能作为「最近一次快照」，留着只会占 keep 名额、
  // 把完整备份挤出去。当天失败的那份由下次启动重试。
  for (const old of incomplete) {
    await rm(join(dir, old.name), { recursive: true, force: true }).catch(() => {});
  }
  complete.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const old of complete.slice(0, Math.max(0, complete.length - keep))) {
    await rm(join(dir, old.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** 最近一次快照信息，读不到就返回 null。 */
export async function latestSnapshot() {
  const dir = memoryPath('.snapshots');
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  const complete = [];
  const legacy = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (!st.isDirectory()) continue;
      try {
        await stat(join(dir, name, '.complete'));
        complete.push({ name, mtimeMs: st.mtimeMs });
        continue;
      } catch { /* 可能是 0.3.11 之前的快照 */ }
      // 兼容旧快照：没有完成标记、但确实有记忆文件，仍算一份可用备份。
      const hasCore = await stat(join(dir, name, 'MEMORY.md')).then(() => true).catch(() => false);
      const hasIndex = hasCore ? true : await stat(join(dir, name, 'index.json')).then(() => true).catch(() => false);
      if (hasIndex) legacy.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* 忽略：不是目录或不可读 */ }
  }
  const all = complete.concat(legacy);
  if (!all.length) return null;
  all.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const last = all[all.length - 1];
  return { name: last.name, count: all.length };
}
