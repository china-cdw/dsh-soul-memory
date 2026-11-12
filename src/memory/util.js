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
// 快照锁的过期阈值：VACUUM INTO 是同步调用，会阻塞事件循环数秒到数十秒，
// 心跳在此期间无法刷新；阈值太小会把活锁当死锁删掉。
export const SNAPSHOT_LOCK_STALE_MS = 10 * 60 * 1000

/** 锁内容里的 pid 还活着吗？进程崩溃留下的锁可以立即回收，不必等 stale 过期。 */
function pidAlive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { return Boolean(e && e.code === 'EPERM') }
}

export async function withFileLock(file, job, { waitMs = null, staleMs = 10000, deadReclaim = true } = {}) {
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
        // 进程崩溃留下的锁：pid 已不存在就立刻回收，不必等 stale 过期（否则要白等十分钟）。
        const holderPid = Number(String(before ?? '').split('-')[0]);
        const dead = Number.isInteger(holderPid) && holderPid > 0 && !pidAlive(holderPid);
        if (dead && Date.now() - st.mtimeMs > 2000 && deadReclaim) {
          // 回收权必须串行：多个进程同时判定同一把锁是死锁时，只有一个能删；
          // 复核内容与 mtime，避免把别人刚抢到的活锁删掉。
          try {
            await withFileLock(lock + '.reclaim', async () => {
              const again = await readFile(lock, 'utf8').catch(() => null)
              const st2 = await stat(lock).catch(() => null)
              if (again !== before || !st2 || Date.now() - st2.mtimeMs <= 2000) return
              await rm(lock, { force: true })
            }, { waitMs: 2000, staleMs: 5000, deadReclaim: false })
          } catch { /* 回收失败就让路，下一轮再试 */ }
        }
        else if (before !== null && Date.now() - st.mtimeMs > staleMs) {
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
  }, Math.min(5000, Math.max(50, Math.floor(staleMs / 4))));
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

const SNAPSHOT_FILES = ['MEMORY.md', 'PERSONA.md', 'CODING.md', 'LESSONS.jsonl', 'GUARD.json', 'index.json'];
const SQLITE_MAGIC = 'SQLite format 3\u0000';

/** 只认真正的 SQLite 文件：大小启发式会把纯文本/半截库当可用备份。 */
async function isSqliteFile(path) {
  try {
    const fh = await open(path, 'r');
    try {
      const buf = Buffer.alloc(16);
      const { bytesRead } = await fh.read(buf, 0, 16, 0);
      return bytesRead === 16 && buf.toString('latin1') === SQLITE_MAGIC;
    } finally {
      await fh.close().catch(() => {});
    }
  } catch {
    return false;
  }
}

/**
 * 每日快照：把记忆文件拷到 <memory>/.snapshots/<时间戳>/，保留最近 keep 份。
 * 同一天只做一次；任何一步失败都只跳过，不影响正常读写。
 * 一份都没拷到（记忆目录还是空的 / 权限问题）时删掉空目录并返回 error，
 * 否则快照列表里会出现一堆空目录，体检和轮转都会被它们污染。
 */
// 删除带重试：Windows 上别的进程可能正占用文件（EBUSY/EPERM），一次失败不等于备份不完整。
async function rmWithRetry(target, options, failed, label) {
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await rm(target, options); return }
    catch (e) {
      lastErr = e
      if (!e || (e.code !== 'EBUSY' && e.code !== 'EPERM')) break
      await new Promise((r) => setTimeout(r, 120))
    }
  }
  if (lastErr && lastErr.code !== 'ENOENT') failed.push(label + ':' + (lastErr.code || 'ERR'))
}

export async function snapshotMemory(options = {}) {
  const dir = memoryPath('.snapshots');
  await mkdir(dir, { recursive: true });
  // 整个快照过程串行化：两个进程同写一天目录会互相覆盖，还可能各自写出 .complete。
  try {
    return await withFileLock(join(dir, '.snapshot.lock'), () => snapshotMemoryLocked(options), { waitMs: 30000, staleMs: SNAPSHOT_LOCK_STALE_MS });
  } catch (e) {
    return { skipped: true, error: e && e.message ? e.message : String(e) };
  }
}

async function snapshotMemoryLocked({ keep = 7 } = {}) {
  const dir = memoryPath('.snapshots');
  const today = new Date().toISOString().slice(0, 10);
  let names = [];
  try { names = await readdir(dir); } catch { names = []; }
  // 只在「今天已完成」时跳过：目录存在不代表拷完了——图谱快照（snapshotGraph）会先建当天目录，
  // 旧实现按目录名前缀判断，会把文件记忆的备份整个跳过去。
  const todayDirs = names.filter((n) => n.startsWith(today)).sort();
  for (const name of todayDirs) {
    try { await stat(join(dir, name, '.complete')); return { skipped: true, dir: join(dir, name), count: names.filter((n) => !n.startsWith('.')).length }; } catch { /* 未完成，继续补 */ }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const createdNew = todayDirs.length === 0;
  const dest = createdNew ? join(dir, stamp) : join(dir, todayDirs[todayDirs.length - 1]);
  await mkdir(dest, { recursive: true });
  // .started 把「正在写/写失败」与「0.3.11 之前的老快照」区分开：
  // 老快照没有它，失败的那种有它但没有 .complete，轮转不能被残片挤掉完整备份。
  try {
    await writeFile(join(dest, '.started'), new Date().toISOString(), 'utf8');
  } catch (e) {
    return { skipped: true, dir: dest, error: '无法写入快照标记：' + (e && e.message ? e.message : String(e)) };
  }
  let copied = 0;
  const failed = [];
  // 先探测源里到底还有哪些文件：源全空（记忆被清空、DSH_HOME 变化）时不能动当天残目录，
  // 否则清完旧文件就 early return，dest 里只剩 .started 和 evolve.sqlite。
  const sourceNames = [];
  // 只有 ENOENT 才能断言「源里没有」；EPERM/EBUSY/ELOOP/EIO 说明状态未知，既不能
  // 当「源里没有」删掉 dest 里的旧副本，也不能当「源里还有」跳过失败记录。
  const definitelyMissing = new Set();
  for (const name of SNAPSHOT_FILES) {
    try { const st = await stat(memoryPath(name)); if (st.isFile()) sourceNames.push(name); else definitelyMissing.add(name); }
    catch (e) { if (e && e.code === 'ENOENT') definitelyMissing.add(name); }
  }
  let hasNotes = false;
  try { hasNotes = (await stat(memoryPath('notes'))).isDirectory(); } catch { hasNotes = false; }
  if (!sourceNames.length && !hasNotes) {
    // 复用已有目录时保留残目录（里面有图谱快照，可能是上次没补完的）；只清自己刚建的空壳。
    if (createdNew) await rm(dest, { recursive: true, force: true }).catch(() => {});
    return { skipped: false, dir: dest, copied: 0, incomplete: [], error: '没有可快照的记忆文件（记忆目录为空或不可读）' };
  }
  // 复用当天目录时必须先清掉旧 notes：cp 是合并复制，源里已删的笔记会留在备份里，
  // 恢复后 reconcileIndex 会让删掉的记忆复活。删除失败（Windows 上文件被占用）要进 failed，
  // 否则会盖 .complete 留下「看起来完整、其实含已删笔记」的备份。
  if (!createdNew) {
    await rmWithRetry(join(dest, 'notes'), { recursive: true, force: true }, failed, 'notes:rm');
  }
  // 先拷 notes 再拷 index.json：反过来的话，恢复时索引可能指向尚未拷到的（或已删除的）笔记。
  try {
    await cp(memoryPath('notes'), join(dest, 'notes'), { recursive: true });
    copied++;
  } catch (e) {
    // ENOENT 表示本来没有 notes；其他错误意味着这天的备份不完整。
    if (e && e.code !== 'ENOENT') failed.push('notes');
  }
  // 复用当天目录时，源里已删的顶层文件同样不能被旧备份"复活"：
  // copyFile 只覆盖不删除，旧 PERSONA.md/GUARD.json 会被 .complete 盖章保留。
  // 源里仍存在的文件不先删：copyFile 会整份替换，反倒避免把「被占用但可覆盖」的文件误判成失败。
  if (!createdNew) {
    // 只清「确认不存在」的；状态未知的文件保持不动，交给下面的逐文件拷贝/失败记录。
    for (const name of definitelyMissing) {
      await rmWithRetry(join(dest, name), { force: true }, failed, name + ':rm');
    }
  }
  for (const name of SNAPSHOT_FILES) {
    // 源里没有这个文件是常态（例如没设过 PERSONA.md）：跳过即可，不能算备份失败。
    let st;
    try { st = await stat(memoryPath(name)); }
    catch (e) {
      if (e && e.code === 'ENOENT') {
        // 探测阶段就确认不存在（多数是没设过 PERSONA.md）：不是失败，上面已清过目标副本。
        if (definitelyMissing.has(name)) continue;
        const before = failed.length;
        await rmWithRetry(join(dest, name), { force: true }, failed, name + ':stale');
        if (failed.length === before) failed.push(name + ':stale');
      } else {
        // 读不到属性 ≠ 源里没有（占用/权限/ELOOP）：不能继续按「完整」写 .complete。
        failed.push(name);
      }
      continue;
    }
    if (!st.isFile()) {
      // 源存在但不是普通文件（目录/设备/链接）：内容不可信，不能继续按「完整」写 .complete。
      const before = failed.length;
      await rmWithRetry(join(dest, name), { force: true }, failed, name + ':notfile');
      if (failed.length === before) failed.push(name + ':notfile');
      continue;
    }
    try {
      // Windows 上别的进程可能正持有 index.json / WAL：EBUSY 重试几次，别把当天备份判成不完整。
      let lastErr = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await copyFile(memoryPath(name), join(dest, name)); lastErr = null; break }
        catch (err) {
          lastErr = err;
          if (!err || (err.code !== 'EBUSY' && err.code !== 'EPERM')) break;
          await new Promise((r) => setTimeout(r, 120));
        }
      }
      if (lastErr) throw lastErr;
      copied++;
    } catch (e) {
      // 只有「stat 之后源才消失」才是危险信号：dest 里可能还留着上一轮副本，
      // 忽略它会让 .complete 把旧内容盖章，恢复时复活已删记忆。删掉旧副本并记失败。
      if (e && e.code === 'ENOENT') {
        const before = failed.length;
        await rmWithRetry(join(dest, name), { force: true }, failed, name + ':stale');
        if (failed.length === before) failed.push(name + ':stale');
      } else {
        failed.push(name);
      }
    }
  }
  if (copied === 0) {
    // 只删自己刚建的目录：复用当天已有目录时，里面可能有 snapshotGraph 写进的 evolve.sqlite，
    // 连带 rm 会把刚做好的图谱快照一起删掉。
    if (createdNew) await rm(dest, { recursive: true, force: true }).catch(() => {});
    return { skipped: false, dir: dest, copied: 0, incomplete: failed, error: '没有可快照的记忆文件（记忆目录为空或不可读）' };
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
  // 本轮正在写的目录必须保护起来：失败时它还没有 .complete，
  // 轮转若把它当残片删掉，就会出现「返回了目录、目录却不存在」。
  await rotateSnapshots(dir, keep, { protect: [dest] });
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
  // 与文件快照共用同一把锁：两者写同一天的目录，不锁会出现两个当天目录、各占一份 keep。
  try {
    return await withFileLock(join(dir, '.snapshot.lock'), () => snapshotGraphLocked(db, keep, dir), { waitMs: 60000, staleMs: SNAPSHOT_LOCK_STALE_MS });
  } catch (e) {
    return { skipped: true, error: e && e.message ? e.message : String(e) };
  }
}

async function snapshotGraphLocked(db, keep, dir) {
  const today = new Date().toISOString().slice(0, 10);
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  let target = names.filter((n) => n.startsWith(today)).sort().pop();
  if (!target) {
    target = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    await mkdir(join(dir, target), { recursive: true });
  }
  const dest = join(dir, target, 'evolve.sqlite');
  // 已有完整副本就跳过：不能只看大小——纯文本或写了一半的库也可能超过 4KB，会永久粘住。
  if (await isSqliteFile(dest)) return { skipped: true, dir: join(dir, target) };
  await rm(dest, { force: true }).catch(() => {});
  // 先落 .started 再 VACUUM：否则大库 VACUUM 超过 10 分钟时，另一个进程的轮转会把
  // 这个「既没标记也没 sqlite」的目录当空壳删掉。写失败就放弃，避免污染别人的目录。
  try {
    await writeFile(join(dir, target, '.started'), new Date().toISOString(), 'utf8');
  } catch (e) {
    return { skipped: true, dir: join(dir, target), error: '无法写入图谱快照标记：' + (e && e.message ? e.message : String(e)) };
  }
  // 进程崩溃留下的临时文件永远不会被 rename，超过 10 分钟就清掉。
  try {
    const leftovers = (await readdir(join(dir, target))).filter((n) => n.startsWith('evolve.sqlite.tmp-'));
    for (const name of leftovers) {
      const p = join(dir, target, name);
      const st = await stat(p).catch(() => null);
      if (st && Date.now() - st.mtimeMs > 10 * 60 * 1000) await rm(p, { force: true }).catch(() => {});
    }
  } catch { /* 目录读不到就跳过清理 */ }
  const tmp = dest + '.tmp-' + process.pid + '-' + Math.random().toString(36).slice(2, 8);
  try {
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const st = await stat(tmp);
    if (!st.size) throw new Error('VACUUM INTO 产出了空文件');
    await rm(dest, { force: true }).catch(() => {});
    await rename(tmp, dest);
    await writeFile(join(dir, target, '.graph'), new Date().toISOString(), 'utf8').catch(() => {});
    // 刚写完的目录没有 .complete（它只放图谱），必须保护，否则会被轮转当成残片删掉。
    await rotateSnapshots(dir, keep, { protect: [join(dir, target)] });
    return { skipped: false, dir: join(dir, target), copied: true };
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    const msg = e && e.message ? e.message : String(e);
    console.error('dsh-x-memory: 图谱快照失败：' + msg);
    return { skipped: true, error: msg };
  }
}

/**
 * 按目录 mtime 轮转：时间戳目录名在跨时区/手工改名时不一定有序，mtime 更可靠。
 * `protect` 里的目录是本轮正在写的，绝不能删——失败了还要留着重试。
 * 0.3.11 之前的快照没有 .complete，但只要有记忆文件就算一份可用备份，参与 keep 计数。
 */
async function rotateSnapshots(dir, keep, { protect = [] } = {}) {
  const protectedNames = new Set(protect.map((p) => String(p).split(/[\\/]/).pop()));
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  const items = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (!st.isDirectory()) continue;
      const has = async (f) => stat(join(dir, name, f)).then(() => true).catch(() => false);
      const complete = await has('.complete');
      const started = await has('.started');
      const hasIndex = await has('index.json');
      const hasMemory = hasIndex ? true : await has('MEMORY.md');
      const hasGraph = await has('evolve.sqlite');
      // 只有真正的 SQLite 库才算图谱完成：半截文件/纯文本不能占 keep。
      const graphDone = hasGraph ? await isSqliteFile(join(dir, name, 'evolve.sqlite')) : false;
      items.push({
        name,
        mtimeMs: st.mtimeMs,
        complete,
        // 写了 .started 却没有 .complete/.graph：本轮写失败/正在写，不是可用备份，也不算 keep。
        inFlight: started && !complete && !graphDone,
        valid: complete || graphDone || (!started && (hasIndex || hasMemory)),
        hasGraph,
        graphDone,
        protected: protectedNames.has(name),
      });
    } catch { /* 读不到就不参与轮转 */ }
  }
  const now = Date.now();
  for (const item of items) {
    if (item.protected) continue;
    // 空壳目录（连记忆文件和图谱都没有）才清；10 分钟年龄门槛避免删掉另一个写者刚建的在途目录。
    if (!item.valid && !item.graphDone && !item.inFlight && now - item.mtimeMs > 10 * 60 * 1000) {
      await rm(join(dir, item.name), { recursive: true, force: true }).catch(() => {});
    }
    // 失败残片留 2 天给重试；超过就清掉，避免永久占目录。
    if (item.inFlight && now - item.mtimeMs > 2 * 86400000) {
      await rm(join(dir, item.name), { recursive: true, force: true }).catch(() => {});
    }
  }
  // 完整备份计入 keep；本轮正在写的 in-flight 目录不在 keepable 里，所以结果可能是 keep+1 份——
  // 这是有意的：保护在途目录优先于份数上限。
  const keepable = items.filter((item) => (item.valid || item.graphDone) && !item.inFlight);
  keepable.sort((a, b) => a.mtimeMs - b.mtimeMs);
  // 先按总数算出该删几份，再从可删集合（排除 protected）里挑最旧的删。
  const excess = Math.max(0, keepable.length - keep);
  const deletable = keepable.filter((item) => !item.protected);
  for (const old of deletable.slice(0, excess)) {
    await rm(join(dir, old.name), { recursive: true, force: true }).catch(() => {});
  }
}

/** 最近一次快照信息，读不到就返回 null。 */
export async function latestSnapshot() {
  const dir = memoryPath('.snapshots');
  const names = (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.'));
  const complete = [];
  const legacy = [];
  const graphs = [];
  for (const name of names) {
    try {
      const st = await stat(join(dir, name));
      if (!st.isDirectory()) continue;
      const hasStarted = await stat(join(dir, name, '.started')).then(() => true).catch(() => false);
      try {
        const mark = await readFile(join(dir, name, '.complete'), 'utf8');
        const stamp = Date.parse(mark.trim());
        complete.push({ name, mtimeMs: Number.isFinite(stamp) ? stamp : st.mtimeMs });
        continue;
      } catch { /* 可能是 0.3.11 之前的快照，或写失败的在途目录 */ }
      // 只有图谱的目录（snapshotGraph 会先写 .started 再写 evolve.sqlite）：它仍是一份可用备份，
      // 必须在「有 .started 就跳过」之前判定，否则 memory_brief 永远看不到图谱备份。
      if (await isSqliteFile(join(dir, name, 'evolve.sqlite'))) { graphs.push({ name, mtimeMs: st.mtimeMs, graph: true }); continue; }
      if (hasStarted) continue; // 残片/在途：不能当作最近一次可用快照
      // 兼容旧快照：没有完成标记、但确实有记忆文件，仍算一份可用备份。
      const hasCore = await stat(join(dir, name, 'MEMORY.md')).then(() => true).catch(() => false);
      const hasIndex = hasCore ? true : await stat(join(dir, name, 'index.json')).then(() => true).catch(() => false);
      if (hasIndex) legacy.push({ name, mtimeMs: st.mtimeMs });
    } catch { /* 忽略：不是目录或不可读 */ }
  }
  const all = complete.concat(legacy, graphs);
  if (!all.length) return null;
  all.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const last = all[all.length - 1];
  return { name: last.name, count: all.length };
}
