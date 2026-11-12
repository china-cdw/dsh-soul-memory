// dsh-x-memory — 核心记忆层
// 移植自 dsh-core-memory 1.0.1（MIT），并入 dsh-soul 底座后统一为一个插件。
//
// 布局（<dshHome>/memory/，默认 ~/.dsh/memory），与原插件完全一致，旧数据可直接复用：
//   MEMORY.md   核心记忆：每个会话系统提示常驻注入（同步读、永远新鲜）
//   notes/      归档记忆：一条一文件，front-matter（id/title/tags/created/updated）
//   index.json  元数据索引（list/search 的真相源；损坏时从 notes/ 重建）
//   PERSONA.md  回复风格
//
// 相对原版的三处增强（v0.1）：
//   1. memory_write 写入前做标题/正文近似度检查，疑似重复时先返回候选并要求 force=true；
//   2. memory_search 的相关度加入时间衰减项（越新越靠前，但不压过关键词命中）；
//   3. memory_brief 一次返回核心记忆、归档、风格与会话图谱的体检数据；
//      memory_search 在关键词无命中或命中不足时，可回落到会话图谱检索（由 index.js 注入）。
import { readFile, mkdir, readdir, rm, stat, writeFile, utimes } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { atomicWrite, createQueue, latestSnapshot, memoryPath, safeJson, sliceSafe, snapshotMemory, withFileLock } from './memory/util.js';
import { checkGuard, isSensitive } from './memory/guard.js';
import {
  buildPersonaText,
  listPresets,
  readPersona,
  renderPersonaFile,
  normalizePersonaInput,
  personaPath,
  MAX_CUSTOM_TEXT,
  PRESETS,
} from './persona.js';
import { registerCodingRules } from './coding.js';
import { registerLessons } from './lessons.js';
import { biliStatus, searchBili } from './memory/bili.js';

const corePath = () => memoryPath('MEMORY.md');
const notesDir = () => memoryPath('notes');
const indexPath = () => memoryPath('index.json');

// 核心记忆的唯一预算：注入截断、写入告警、体检提示、模板提示都用它，
// 避免「已截断却还说不超限」这类文档与实现不一致。
const CORE_BUDGET = 3000;

const TEMPLATE = [
  '# DSH 核心记忆',
  '',
  '> 由 dsh-x-memory 插件维护，并注入每个会话的系统提示。保持精炼（建议 ' + CORE_BUDGET + ' 字内）。',
  '> 可用 memory_core 工具增删改，也可手工编辑（插件每次组装时同步读取，立即可见）。',
  '',
  '## 用户',
  '- （长期有效的用户画像与偏好，用 memory_core append 追加）',
  '',
  '## 环境',
  '- （机器、部署、常用路径等长期事实）',
  '',
  '## 项目',
  '- （进行中的项目、关键决策与约定）',
  '',
].join('\n');

// ---------- 纯函数 ----------
function noteSort(a, b) { return (b.created || '').localeCompare(a.created || '') }

function parseNoteFile(text) {
  const out = { meta: {}, body: text };
  if (typeof text === 'string' && text.startsWith('---')) {
    const end = text.indexOf('\n---', 3);
    if (end >= 0) {
      const fm = text.slice(3, end);
      out.body = text.slice(end + 4).replace(/^\n+/, '');
      for (const line of fm.split('\n')) {
        const at = line.indexOf(':');
        if (at > 0) out.meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
      }
    }
  }
  return out;
}

// 只把这些标题当成真正的分节。分节正文里手写的二级标题（如 `## 端口`）不再切出新节——
// 以前任意 `## ` 都切，replace/remove 只改到前半段，后半段变成孤立分节，结构就坏了。
const CORE_SECTION_NAMES = new Set(['用户', '环境', '项目', '偏好', '背景', '约定', '决策', '待办', '其他']);
function isCoreSectionTitle(title) {
  return CORE_SECTION_NAMES.has(String(title ?? '').trim());
}

function parseCoreSections(text) {
  const lines = String(text).split('\n');
  const header = [];
  const sections = [];
  let current = null;
  let body = [];
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && isCoreSectionTitle(m[1])) {
      if (current !== null) sections.push({ title: current, body: body.join('\n') });
      current = m[1].trim();
      body = [];
    } else if (current !== null) {
      body.push(line);
    } else {
      header.push(line);
    }
  }
  if (current !== null) sections.push({ title: current, body: body.join('\n') });
  return { header: header.join('\n'), sections };
}

function renderCore(parsed) {
  let text = parsed.header;
  for (const s of parsed.sections) {
    const body = s.body.replace(/^\n+/, '').replace(/\n+\s*$/, '');
    text += '\n## ' + s.title + '\n' + (body ? body + '\n' : '');
  }
  return text;
}

function makeId(title, existing) {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = '' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  const slug = String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '');
  // 随机后缀：并发写入（或同一秒内两条记忆）不会抢同一个文件名，
  // 索引里也不会出现「先写后覆盖」的静默丢条目。
  const rand = randomUUID().replace(/-/g, '').slice(0, 6);
  const base = stamp + (slug ? '-' + slug : '') + '-' + rand;
  const taken = new Set(existing.map((n) => n.id));
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) { candidate = base + '-' + n; n++; }
  return candidate;
}

function noteFileText(meta, content) {
  return '---\n' +
    'id: ' + meta.id + '\n' +
    'title: ' + meta.title + '\n' +
    'tags: ' + ((meta.tags || []).join(', ')) + '\n' +
    'created: ' + meta.created + '\n' +
    'updated: ' + meta.updated + '\n' +
    (meta.supersededBy ? 'supersededBy: ' + meta.supersededBy + '\n' : '') +
    (meta.sensitive ? 'sensitive: true\n' : '') +
    '---\n\n' + content + '\n';
}

function tokensOf(text) {
  const out = [];
  for (const chunk of String(text || '').toLowerCase().split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!chunk) continue;
    if (/^[a-z0-9]+$/.test(chunk)) {
      if (chunk.length >= 2 || /\d/.test(chunk)) out.push(chunk);
      continue;
    }
    // 中文没有空格：整段连续中文若只当一个 token，任何改写都无法命中。
    // 因此同时收录整段与相邻二字组合（bigram），让「近重复」在中文里也能被识别。
    if (chunk.length >= 2) out.push(chunk);
    for (let i = 0; i + 2 <= chunk.length; i++) out.push(chunk.slice(i, i + 2));
  }
  return out;
}

/** 近重复判定：标题与正文前 120 个 token 的 Jaccard 相似度。返回 0..1。 */
function similarity(aTitle, aBody, bTitle, bBody) {
  const a = new Set([...tokensOf(aTitle), ...tokensOf(aBody).slice(0, 120)]);
  const b = new Set([...tokensOf(bTitle), ...tokensOf(bBody).slice(0, 120)]);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const t of a) if (b.has(t)) shared++;
  const union = a.size + b.size - shared;
  // 用 Jaccard 而非 shared/min：短文本里 min 做分母会把「只差一个词」的条目判成重复。
  return union > 0 ? shared / union : 0;
}

function scoreNote(note, query, bodyText, now = Date.now()) {
  const q = String(query || '').toLowerCase();
  // 与相似度判定共用同一套分词（中文 bigram），否则「近重复能识别、检索却搜不到」。
  const tokens = [...new Set(tokensOf(q))];
  const title = (note.title || '').toLowerCase();
  const tagStr = (note.tags || []).join(' ').toLowerCase();
  const body = (bodyText || '').toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (title.indexOf(t) >= 0) score += 3;
    if (tagStr.indexOf(t) >= 0) score += 3;
    let hits = 0;
    let at = 0;
    while (hits < 50) {
      const i = body.indexOf(t, at);
      if (i < 0) break;
      score += 1;
      hits++;
      at = i + t.length;
    }
  }
  if (tokens.length > 1 && body.indexOf(q) >= 0) score += 2;
  if (score > 0) {
    // 时间衰减：新记忆最多 +25%，旧记忆不扣分（关键词命中仍是主信号）。
    const when = Date.parse(note.updated || note.created || '');
    if (Number.isFinite(when)) {
      const days = Math.max(0, (now - when) / 86400000);
      score *= 1 + 0.25 * Math.exp(-days / 45);
    }
  }
  return score;
}

function makeSnippet(bodyText, query) {
  const flat = String(bodyText).replace(/\s+/g, ' ').trim();
  const lower = flat.toLowerCase();
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  let at = -1;
  for (const t of tokens) {
    const i = lower.indexOf(t);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return flat.slice(0, 120) + (flat.length > 120 ? '…' : '');
  const start = Math.max(0, at - 40);
  const end = Math.min(flat.length, at + 120);
  return (start > 0 ? '…' : '') + flat.slice(start, end) + (end < flat.length ? '…' : '');
}

// prompt 组装对 {{variable}} 严格插值——注入前把字面 {{ 拆开，避免撞变量语法
function sanitize(text) { return String(text).split('{{').join('{ {') }

// ---------- fs 辅助 ----------
// 读取失败 ≠ 文件不存在：非 ENOENT 的错误必须往上抛。
// 以前一律返回 null，bootstrap 见状就写模板，读权限/占用类错误会把用户的常驻记忆整体覆盖。
function readFileSyncOrNull(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
}

/** 展示/体检用：任何读取错误都返回 null，不让一次读失败把整个工具打挂。 */
function readFileLoose(path) {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** 写索引：跨进程用 index.json.lock 串行化，锁超时视为崩溃残留并清理。 */
const INDEX_LOCK_STALE_MS = 30000;
// 等待必须大于过期阈值：锁持有者只是慢（大库查重），不是死了。
const INDEX_LOCK_WAIT_MS = 35000;
let indexLockDepth = 0;

async function withIndexLock(job) {
  const lock = indexPath() + '.lock';
  await mkdir(dirname(lock), { recursive: true });
  const token = process.pid + '-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  const started = Date.now();
  for (;;) {
    try {
      // wx：已存在就失败，天然互斥，不需要额外判断。
      await writeFile(lock, token, { flag: 'wx' });
      break;
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      // 超时判断放在所有分支之前：stat 本身持续失败（EPERM/EBUSY）时也必须退出，不能空转。
      const staleMs = Number(process.env.DSH_X_MEMORY_LOCK_STALE_MS) || INDEX_LOCK_STALE_MS;
      // 等待必须严格大于过期：否则本进程先判别人过期、别人也判本进程过期，两个写者会互相拆锁。
      // 显式配置的等待时间优先（测试与快速失败场景需要短等待）；
      // 默认值必须大于过期阈值，否则两个进程会同时判对方过期并互相拆锁。
      const waitEnv = Number(process.env.DSH_X_MEMORY_LOCK_WAIT_MS);
      const waitMs = waitEnv || Math.max(INDEX_LOCK_WAIT_MS, Math.ceil(staleMs * 1.2));
      if (Date.now() - started > waitMs) throw new Error('索引写入被占用（index.json.lock 超过 ' + (waitMs / 1000) + ' 秒未释放）');
      try {
        // stat 与 rm 之间持有者可能换人：读内容、stat、再读内容，
        // 内容与 mtime 都没变才敢删，否则会把别人新建的有效锁删掉。
        const before = await readFile(lock, 'utf8').catch(() => null);
        const st = await stat(lock);
        if (before !== null && Date.now() - st.mtimeMs > staleMs) {
          const again = await readFile(lock, 'utf8').catch(() => null);
          const st2 = await stat(lock);
          if (again === before && st2.mtimeMs === st.mtimeMs) await rm(lock, { force: true });
        }
      } catch { /* 锁刚好被持有者删掉，睡一下再试 */ }
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  // 心跳：慢查询/大库重建超过 STALE 时，避免被其他进程当成死锁清掉。
  const beatStale = Number(process.env.DSH_X_MEMORY_LOCK_STALE_MS) || INDEX_LOCK_STALE_MS;
  const beat = setInterval(() => {
    // 只给自己持有的锁续命：锁被当成过期清掉又被别人抢到时，替对方刷新 mtime 会掩盖真实死锁。
    readFile(lock, 'utf8')
      .then((held) => {
        if (held !== token) return undefined;
        const now = new Date();
        return utimes(lock, now, now);
      })
      .catch(() => {});
  }, Math.max(200, Math.floor(beatStale / 4)));
  beat.unref?.();
  try {
    indexLockDepth += 1;
    return await job();
  } finally {
    indexLockDepth -= 1;
    clearInterval(beat);
    try {
      const held = await readFile(lock, 'utf8');
      if (held === token) await rm(lock, { force: true });
    } catch { /* 锁已不在 */ }
  }
}

async function persistIndex(notes) {
  await withIndexLock(() => atomicWrite(indexPath(), JSON.stringify({ version: 1, notes }, null, 2)));
}

/**
 * 锁内读-改-写：loadIndex 必须在锁内执行。锁外读取再锁内写，两个进程会各自拿着旧索引，
 * 后写者覆盖前者的新增，甚至把已删条目写回来。
 * job(notes) 返回 { notes, value } 或 { value }（不改索引时省略 notes）。
 */
async function withLockedIndex(job) {
  return withIndexLock(async () => {
    const notes = await loadIndex();
    const result = await job(notes);
    if (result && result.notes) {
      await atomicWrite(indexPath(), JSON.stringify({ version: 1, notes: result.notes }, null, 2));
    }
    return result ? result.value : undefined;
  });
}

async function rebuildIndex({ persist = true } = {}) {
  // 读目录与写索引必须同锁：否则扫描窗口内并发新增的条目不进索引，
  // 已删除的条目会被这份旧结果写回。锁内重建不再二次加锁。
  if (indexLockDepth > 0) return rebuildIndexLocked({ persist: false });
  return withIndexLock(() => rebuildIndexLocked({ persist }));
}

async function rebuildIndexLocked({ persist = true } = {}) {
  bodyCache.clear();
  const out = [];
  let entries = [];
  const dir = notesDir();
  try { entries = await readdir(dir); } catch { entries = []; }
  for (const name of entries) {
    if (!name.endsWith('.md')) continue;
    try {
      const text = await readFile(join(dir, name), 'utf8');
      const parsed = parseNoteFile(text);
      if (parsed.meta.deleted === 'true') continue; // 墓碑文件不复活
      const id = name.slice(0, -3);
      out.push({
        id,
        title: parsed.meta.title || id,
        tags: (parsed.meta.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        created: parsed.meta.created || '',
        updated: parsed.meta.updated || parsed.meta.created || '',
        size: text.length,
        ...(parsed.meta.supersededBy ? { supersededBy: parsed.meta.supersededBy } : {}),
        ...(parsed.meta.sensitive === 'true' ? { sensitive: true } : {}),
      });
    } catch { /* 跳过无法解析的文件 */ }
  }
  const sorted = out.sort(noteSort);
  if (persist) {
    // 已在索引锁内：直接原子写，不能再调 persistIndex（它会二次加锁导致自锁）。
    try { await atomicWrite(indexPath(), JSON.stringify({ version: 1, notes: sorted }, null, 2)); } catch { /* 索引暂时不可写 */ }
  }
  return sorted;
}

async function loadIndex() {
  let raw = null;
  try { raw = await readFile(indexPath(), 'utf8'); } catch { raw = null; }
  if (raw !== null) {
    const parsed = safeJson(raw, null);
    if (parsed && Array.isArray(parsed.notes)) {
      return parsed.notes.filter((n) => n && typeof n.id === 'string').sort(noteSort);
    }
  }
  // 锁内重建不能再写索引：persistIndex 会再次抢同一把锁，白等一个 WAIT。
  return rebuildIndex({ persist: indexLockDepth === 0 });
}

/**
 * 启动对账：notes/ 与 index.json 谁多出来的都要收口。
 * - 文件有、索引无：补录（外部新增或上次写到一半）；
 * - 索引有、文件无：标 missing，不再当作正常条目展示，但保留 id 供人工处理。
 */
async function reconcileIndex() {
  // 读和写必须在同一把锁里：锁外读、锁内写时，两个进程会互相覆盖，
  // 把刚删掉的条目写回来、或把刚新增的条目冲掉。
  return withIndexLock(() => reconcileIndexLocked());
}

async function reconcileIndexLocked() {
  const notes = await loadIndex();
  const byId = new Map(notes.map((n) => [n.id, n]));
  const dir = notesDir();
  let files = [];
  try {
    files = await readdir(dir);
  } catch {
    // 目录读不出来（占用/权限/离线）时不能把「没读到」当成「全没了」，
    // 否则会把全部记忆标 missing 并落盘，注入与检索里整段消失。
    return notes;
  }
  const fileIds = new Set();
  let changed = false;
  for (const name of files) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    let parsed = null;
    try { parsed = parseNoteFile(await readFile(join(dir, name), 'utf8')); } catch (e) {
      // 只有 ENOENT 才算文件真的没了，交给下面的缺失判断；
      // 其他读错误（占用、权限、杀软锁）说明文件还在，标 missing 会让内容从检索里消失。
      if (!e || e.code !== 'ENOENT') fileIds.add(id);
      continue;
    }
    if (parsed.meta.deleted === 'true') {
      // 墓碑：若索引里还留着（上次删除在写索引前中断），这里补完删除。
      if (byId.has(id)) { byId.delete(id); changed = true; }
      continue;
    }
    fileIds.add(id);
    if (byId.has(id)) continue;
    byId.set(id, {
      id,
      title: parsed.meta.title || id,
      tags: (parsed.meta.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
      created: parsed.meta.created || '',
      updated: parsed.meta.updated || parsed.meta.created || '',
      size: parsed.meta.size ? Number(parsed.meta.size) : 0,
      ...(parsed.meta.supersededBy ? { supersededBy: parsed.meta.supersededBy } : {}),
      ...(parsed.meta.sensitive === 'true' ? { sensitive: true } : {}),
    });
    changed = true;
  }
  for (const note of [...byId.values()]) {
    const missing = !fileIds.has(note.id);
    if (Boolean(note.missing) === missing) continue;
    const next = { ...note };
    delete next.missing;
    if (missing) next.missing = true;
    byId.set(note.id, next);
    changed = true;
  }
  const merged = [...byId.values()].sort(noteSort);
  if (changed) {
    bodyCache.clear();
    try {
      // 已经在索引锁内：直接写索引，不能再调 persistIndex（它会二次抢同一把锁，导致自锁超时）。
      await atomicWrite(indexPath(), JSON.stringify({ version: 1, notes: merged }, null, 2));
    } catch { /* 对账写失败不影响读取 */ }
  }
  return merged;
}

// 写串行化：同进程多 agent 并发写也按序落盘
const enqueue = createQueue();

function errText(e) { return '操作失败：' + (e && e.message ? e.message : String(e)); }

/** 失败结果统一带机器可读后缀，便于调用方按 code 分支而不是匹配中文。 */
function failMessage(code, message) { return message + '\n[err:' + code + ']'; }

/** 按长度截断；若截断点落在未闭合的代码围栏内，补一个关闭围栏，而不是删内容。 */
function truncateWithFences(text, max) {
  if (text.length <= max) return text;
  let cut = sliceSafe(text, max);
  const marker = openFenceMarker(cut);
  if (marker) cut += (cut.endsWith('\n') ? '' : '\n') + marker + '\n';
  return cut;
}

/** 返回尚未闭合的围栏标记；支持 ``` 与 ~~~、缩进 ≤3、关闭需长度 ≥ 开启。 */
function openFenceMarker(text) {
  let open = null;
  for (const line of text.split('\n')) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (!m) continue;
    const run = m[1];
    if (!open) { open = { ch: run[0], len: run.length }; continue; }
    if (run[0] === open.ch && run.length >= open.len && m[2].trim() === '') open = null;
  }
  return open ? open.ch.repeat(open.len) : null;
}

/** 读取并限制请求体大小（防误用），返回 UTF-8 文本。 */
/**
 * 读取请求体。超限时不 destroy 连接（那会让客户端只看到连接重置），
 * 而是排空剩余数据后返回 { tooLarge: true }，由调用方回 413。
 */
function readBody(req, limit = 16384) {
  return new Promise((resolve) => {
    let size = 0;
    let tooLarge = false;
    const chunks = [];
    const finish = () => resolve({ tooLarge, body: tooLarge ? '' : Buffer.concat(chunks).toString('utf8') });
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        if (!tooLarge) {
          tooLarge = true;
          chunks.length = 0;
          try { req.resume(); } catch { /* 忽略 */ }
        }
        return;
      }
      if (!tooLarge) chunks.push(chunk);
    });
    req.on('end', finish);
    req.on('error', finish);
    req.on('close', finish);
  });
}

// ---------- 召回节（同步读，每次模型组装永远新鲜） ----------
// 节文本缓存：模型每次组装都会调用，但底层文件通常隔很久才变；
// 用 core/index/persona 三个文件的 mtime+size 作键，任何一处手改都会重建。
let sectionCache = null; // { key, text }

function fileStamp(file) {
  try { const st = statSync(file); return st.mtimeMs + ':' + st.size; } catch { return '-'; }
}

function buildSectionText() {
  const key = fileStamp(corePath()) + '|' + fileStamp(indexPath()) + '|' + fileStamp(personaPath());
  if (sectionCache && sectionCache.key === key) return sectionCache.text;
  const text = renderSectionText();
  sectionCache = { key, text };
  return text;
}

function renderSectionText() {
  try {
    let core = '';
    const coreRaw = readFileLoose(corePath());
    if (coreRaw !== null) core = coreRaw.trim();
    let coreNote = '';
    if (core.length > CORE_BUDGET) {
      core = sliceSafe(core, CORE_BUDGET);
      coreNote = '\n（核心记忆过长已截断——请尽快用 memory_core 精简）';
    }
    let notes = [];
    const indexRaw = readFileLoose(indexPath());
    if (indexRaw) {
      const parsed = safeJson(indexRaw, null);
      if (parsed && Array.isArray(parsed.notes)) notes = parsed.notes.filter((n) => n && typeof n.id === 'string').sort(noteSort);
    }
    // 标题/标签来自用户输入，注入系统提示前必须过 sanitize（防 {{ }} 模板插值注入）。
    const recent = notes.filter((n) => !n.sensitive && !n.missing).slice(0, 12).map((n) =>
      '- [' + sanitize(n.id) + '] ' + sanitize(n.title) +
      ((n.tags && n.tags.length) ? '  #' + n.tags.map((t) => sanitize(t)).join(' #') : '') +
      (n.supersededBy ? '（已被取代）' : '')
    ).join('\n');
    const persona = buildPersonaText();
    return [
      '# 跨会话记忆（dsh-x-memory）',
      '',
      '你在本机的所有会话共享以下持久记忆。核心记忆常驻注入；归档记忆仅列索引，用 memory_search / memory_read 按需取用。',
      '会话过程记忆（约束、决策、产物、历史原文）由同一插件的 soul_recall 检索，两者互补。',
      '',
      '## 核心记忆（MEMORY.md）',
      sanitize(core) || '（空）',
      coreNote,
      ...(persona ? ['', '## 回复风格（用户设置）', sanitize(persona)] : []),
      '',
      '## 最近归档记忆（新→旧，最多 12 条）',
      recent || '（暂无归档记忆）',
      '',
      '## 使用政策',
      '- 当用户表达长期偏好、纠正你的做法、给出长期有效的环境/项目事实或重要决策时：立即用 memory_write（归档）或 memory_core（核心）保存，不要等用户要求。',
      '- 保存的内容必须自包含：未来会话看不到当前对话，要写清楚背景。',
      '- 不要保存：一次性细节、敏感信息（密码/凭据/token）、能从代码或文件轻易恢复的信息。',
      '- 需要回忆细节时主动 memory_search（长期事实）；需要会话过程、旧账、命令输出时用 soul_recall。',
      '- 不确定记忆库状态时用 memory_brief 一次看全（核心、归档、风格、会话图谱）。',
      '- 用户要求改变回复风格时：用 persona 工具（action=set 切预设 / action=custom 写自定义），不要写进 MEMORY.md。',
    ].join('\n');
  } catch {
    return '（跨会话记忆：暂不可用）';
  }
}

// 正文缓存：搜索与查重不再每条笔记每次读盘。
// 失效点：文件 mtime/size 变化（外部编辑也能感知）、写入、删除、索引重建。
const bodyCache = new Map(); // id -> { body, mtimeMs, size }
async function readNoteBody(id) {
  const file = join(notesDir(), id + '.md');
  let st = null;
  try { st = await stat(file); } catch { bodyCache.delete(id); return ''; }
  const hit = bodyCache.get(id);
  if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.body;
  let body = '';
  try { body = parseNoteFile(await readFile(file, 'utf8')).body; } catch { body = ''; }
  bodyCache.set(id, { body, mtimeMs: st.mtimeMs, size: st.size });
  return body;
}

// ---------- 工具实现 ----------
async function markSuperseded(target, newId) {
  const file = join(notesDir(), target.id + '.md');
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return false; }
  const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  let next;
  if (fmEnd < 0) {
    // 没有 front-matter 的旧文件：补一个最小头，正文原样保留。
    next = `---\nid: ${target.id}\nupdated: ${new Date().toISOString()}\nsupersededBy: ${newId}\n---\n\n${text}`;
  } else {
    // 按行改写而不是重新序列化：未知字段（外部工具写入的）不再被静默丢掉。
    const lines = text.slice(3, fmEnd).split('\n')
      .filter((line) => line.trim() && !/^(updated|supersededBy)\s*:/.test(line.trim()));
    lines.push(`updated: ${new Date().toISOString()}`);
    lines.push(`supersededBy: ${newId}`);
    next = `---${lines.map((line) => '\n' + line).join('')}\n---${text.slice(fmEnd + 4)}`;
  }
  await atomicWrite(file, next);
  return true;
}

async function writeNote(args) {
  const title = typeof args.title === 'string' ? args.title.replace(/\s+/g, ' ').trim() : '';
  const content = typeof args.content === 'string' ? args.content : '';
  if (!title || !content.trim()) return failMessage('E_ARG', '保存失败：title 和 content 均不能为空。');
  // 标签用逗号分隔落盘：标签内部若含逗号会让 index 与文件解析结果不一致，写入时统一抹平。
  const tags = Array.isArray(args.tags)
    ? args.tags.filter((t) => typeof t === 'string' && t.trim())
      .map((t) => t.trim().replace(/,/g, ' ').replace(/\s+/g, ' ').trim())
      .filter(Boolean)
    : [];
  const force = args.force === true;
  const supersedes = typeof args.supersedes === 'string' ? normalizeRef(args.supersedes) : '';
  const guard = checkGuard(title + '\n' + content);
  if (guard.kind === 'reject') {
    return failMessage('E_GUARD', '拒绝保存：内容命中守卫规则（私钥或凭据形状），未落盘。请删掉敏感片段后重试。');
  }
  const sensitive = guard.kind === 'sensitive';
  try {
    return await enqueue(() => withLockedIndex(async (existing) => {
      let target = null;
      if (supersedes) {
        const hits = existing.filter((n) => n.id === supersedes || n.id.indexOf(supersedes) === 0);
        if (hits.length === 0) return { value: failMessage('E_NOT_FOUND', '保存失败：没有找到要取代的记忆「' + supersedes + '」。可先用 memory_list 查看 id。') };
        if (hits.length > 1) return { value: failMessage('E_AMBIGUOUS', 'id 有歧义，请精确指定：\n' + hits.map((n) => '- [' + n.id + '] ' + n.title).join('\n')) };
        target = hits[0];
      }
      if (!force && !target) {
        const near = [];
        // 查重只扫最近 500 条：再多会让每次写入退化成全库读盘；命中后仍可 force 写入。
        for (const note of existing.slice(0, 500)) {
          const sim = similarity(title, content, note.title || '', await readNoteBody(note.id));
          if (sim >= 0.55) near.push({ note, sim });
        }
        if (near.length) {
          near.sort((a, b) => b.sim - a.sim);
          return { value: '疑似重复，未写入。已有记忆：\n' + near.slice(0, 5).map((h) =>
            '- [' + h.note.id + '] ' + h.note.title + '（相似度 ' + h.sim.toFixed(2) + '）'
          ).join('\n') + '\n\n如果确实要新增，带 force=true 重新调用；如果这是对某条记忆的更新或修正，带 supersedes=<旧 id> 重新调用，旧条目会被标记为「已被取代」而不是删除。\n[err:E_DUPLICATE]' };
        }
      }
      const id = makeId(title, existing);
      const now = new Date().toISOString();
      const meta = { id, title, tags, created: now, updated: now, size: 0, ...(sensitive ? { sensitive: true } : {}) };
      const fileText = noteFileText(meta, content);
      meta.size = fileText.length;
      await atomicWrite(join(notesDir(), id + '.md'), fileText);
      bodyCache.delete(id); // 新文件，下一次读取重新解析
      let notes = [meta, ...existing].sort(noteSort);
      let superseded = false;
      if (target) {
        superseded = await markSuperseded(target, id);
        bodyCache.delete(target.id);
        if (superseded) notes = notes.map((n) => (n.id === target.id ? { ...n, supersededBy: id, updated: now } : n));
      }
      sectionCache = null;
      return { notes, value: '已保存归档记忆 [' + id + '] ' + title + (tags.length ? ' #' + tags.join(' #') : '') + '。已进入索引，所有会话可见。' +
        (superseded ? '\n旧条目 [' + target.id + '] ' + target.title + ' 已标记为「已被 ' + id + ' 取代」。' : '') +
        (sensitive ? '\n注意：内容疑似包含凭据，已标记为敏感——不会进入系统提示，检索时只显示标题。' : '') };
    }));
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

async function searchNotes(args, graphSearch, agent, bridge) {
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (!query) return failMessage('E_ARG', '搜索失败：query 不能为空。');
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 30) : 8;
  try {
    const notes = await loadIndex();
    const now = Date.now();
    const scored = [];
    // 正文走缓存：同一次搜索里每条笔记只读一次盘，重复搜索直接命中内存。
    for (const note of notes) {
      const bodyText = await readNoteBody(note.id);
      const score = scoreNote(note, query, bodyText, now);
      if (score > 0) scored.push({ note, score, bodyText });
    }
    scored.sort((a, b) => b.score - a.score);

    // 图谱总会补一轮：归档通常只有一两条笔记，而"当时怎么做的"大多只留在会话图里。
    const graphHits = [];
    if (graphSearch && agent) {
      try {
        const hits = await graphSearch(agent, query);
        if (Array.isArray(hits)) graphHits.push(...hits.slice(0, 6));
      } catch { /* 图谱不可用不影响归档检索 */ }
    }

    const sections = [];
    if (scored.length) {
      const shown = scored.slice(0, limit);
      const lines = shown.map((hit) => {
        const flags = (hit.note.supersededBy ? '（已被 [' + hit.note.supersededBy + '] 取代）' : '') +
          (hit.note.sensitive ? '（敏感内容已隐藏）' : '');
        const body = hit.note.sensitive ? '（正文含疑似凭据，已隐藏；确需查看用 memory_read ' + hit.note.id + '）' : makeSnippet(hit.bodyText, query);
        return '[' + hit.note.id + '] ' + hit.note.title + '（' + (hit.note.created || '').slice(0, 10) + '）' + flags + '\n  ' +
          body + '\n  读取：memory_read ' + hit.note.id;
      });
      sections.push('【归档记忆】找到 ' + scored.length + ' 条（显示前 ' + shown.length + ' 条）：\n\n' + lines.join('\n\n'));
    }

    if (graphHits.length) {
      const lines = graphHits.map((h) => {
        const stale = h.superseded ? '（已被后续结论取代）' : '';
        return '- [' + (h.kind || 'node') + '] ' + String(h.claim || '').slice(0, 200) + stale;
      });
      sections.push('【会话图谱】' + graphHits.length + ' 条相关节点（soul 图谱；需要原文用 soul_recall 或 soul_expand 展开）：\n' + lines.join('\n'));
    }

    // billion-context 桥接：只读它的会话压缩摘要，作为第三路来源；任何异常都静默降级。
    if (bridge && bridge.enabled !== false) {
      try {
        const bili = await searchBili(query, {
          sessionsDir: bridge.sessionsDir,
          maxSessions: bridge.maxSessions,
          maxChars: bridge.maxChars,
        });
        if (bili && bili.text) sections.push(bili.text);
      } catch { /* 桥接失败不影响归档与图谱 */ }
    }

    if (!sections.length) return '没有匹配「' + query + '」的记忆。可尝试其他关键词，或用 memory_list 浏览全部。';
    return sections.join('\n\n');
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

/** 统一 id 归一化：去掉方括号（memory_list 打印的就是 [id]）与 .md 后缀。 */
function normalizeRef(ref) {
  // 先去掉 .md 再去方括号：'[abc].md' 若先剥方括号，结尾的 ] 不在行尾，会残留成 'abc]'。
  return String(ref || '').trim().replace(/\.md$/, '').replace(/^\[|\]$/g, '').trim();
}

async function readNote(ref) {
  if (!ref) return failMessage('E_ARG', '读取失败：id 不能为空。可用 memory_list 获取 id。');
  const refClean = normalizeRef(ref);
  // '[]' / '[' / '.md' 归一化后是空串：空串做前缀匹配会命中全部条目，必须当场拒绝。
  if (!refClean) return failMessage('E_ARG', '读取失败：id 不能为空。可用 memory_list 获取 id。');
  try {
    const notes = await loadIndex();
    const clean = refClean;
    let matches = notes.filter((n) => n.id === clean);
    if (matches.length === 0) matches = notes.filter((n) => n.id.indexOf(clean) === 0);
    if (matches.length === 0) return failMessage('E_NOT_FOUND', '未找到记忆「' + ref + '」。可用 memory_list 浏览全部 ' + notes.length + ' 条归档记忆。');
    if (matches.length > 1) return failMessage('E_AMBIGUOUS', 'id 有歧义，候选：\n' + matches.map((n) => '- [' + n.id + '] ' + n.title).join('\n'));
    const note = matches[0];
    let text = '';
    try {
      text = await readFile(join(notesDir(), note.id + '.md'), 'utf8');
    } catch (e) {
      return failMessage('E_READ', '记忆 [' + note.id + '] 在索引中存在但文件读取失败：' + errText(e));
    }
    const parsed = parseNoteFile(text);
    let out = '[' + note.id + '] ' + note.title +
      (note.supersededBy ? '（已被 [' + note.supersededBy + '] 取代）' : '') +
      (note.sensitive ? '（敏感内容）' : '') +
      '\n创建：' + note.created + ((note.tags && note.tags.length) ? '\n标签：' + note.tags.join(', ') : '') + '\n\n' +
      (note.sensitive ? '（此条被守卫标记为疑似凭据，正文默认隐藏；下面是显式读取内容）\n\n' : '') + parsed.body;
    if (out.length > 8000) out = truncateWithFences(out, 8000) + '\n…（内容过长已截断）';
    return out;
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

async function listNotes(args) {
  const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 100) : 15;
  const tag = typeof args.tag === 'string' ? args.tag.trim().toLowerCase() : '';
  try {
    let notes = await loadIndex();
    if (tag) notes = notes.filter((n) => (n.tags || []).some((t) => String(t).toLowerCase() === tag));
    if (notes.length === 0) return tag ? '没有带标签 #' + tag + ' 的记忆。' : '暂无归档记忆。';
    const lines = notes.slice(0, limit).map((n) =>
      '- [' + n.id + '] ' + n.title + ((n.tags && n.tags.length) ? '  #' + n.tags.join(' #') : '') +
      (n.supersededBy ? '（已被 [' + n.supersededBy + '] 取代）' : '') +
      (n.sensitive ? '（敏感）' : '') +
      (n.missing ? '（文件缺失）' : '') +
      '（' + (n.created || '').slice(0, 10) + '）'
    );
    return '归档记忆共 ' + notes.length + ' 条（显示前 ' + Math.min(limit, notes.length) + ' 条，新→旧）：\n' + lines.join('\n');
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

async function deleteNote(ref) {
  if (!ref) return failMessage('E_ARG', '删除失败：id 不能为空。');
  const refClean = normalizeRef(ref);
  if (!refClean) return failMessage('E_ARG', '删除失败：id 不能为空。');
  try {
    return await enqueue(() => withLockedIndex(async (notes) => {
      const clean = refClean;
      const matches = notes.filter((n) => n.id === clean || n.id.indexOf(clean) === 0);
      if (matches.length === 0) return { value: failMessage('E_NOT_FOUND', '删除失败：未找到「' + ref + '」。可用 memory_list 浏览全部。') };
      if (matches.length > 1) return { value: failMessage('E_AMBIGUOUS', 'id 有歧义，请精确指定：\n' + matches.map((n) => '- [' + n.id + '] ' + n.title).join('\n')) };
      const note = matches[0];
      const next = notes.filter((n) => n.id !== note.id);
      bodyCache.delete(note.id);
      // 先落墓碑再改索引：即使进程死在中间，重启对账也不会把该条「复活」。
      // 墓碑写失败就直接中止，避免出现「索引没了、正文还在」的半删除状态。
      await atomicWrite(join(notesDir(), note.id + '.md'), '---\ndeleted: true\nid: ' + note.id + '\n---\n\n（此记忆已删除）\n');
      sectionCache = null;
      return { notes: next, value: '已删除记忆 [' + note.id + '] ' + note.title + '。' };
    }));
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

async function editCore(args) {
  const action = args.action;
  if (action !== 'append' && action !== 'replace' && action !== 'remove') {
    return failMessage('E_ARG', '编辑失败：action 必须是 append / replace / remove。');
  }
  const section = typeof args.section === 'string' ? args.section.trim() : '';
  const text = typeof args.text === 'string' ? args.text : '';
  if (!section) return failMessage('E_ARG', '编辑失败：section 不能为空。');
  if ((action === 'append' || action === 'replace') && !text.trim()) return failMessage('E_ARG', '编辑失败：append/replace 需要提供 text。');
  const guard = checkGuard(section + '\n' + text);
  if (guard.kind) {
    return failMessage('E_GUARD', '拒绝写入核心记忆：内容命中守卫规则（私钥/凭据形状），核心记忆会注入每个会话，不能保存这类内容。');
  }
  if (!isCoreSectionTitle(section)) {
    return failMessage('E_ARG', '编辑失败：分节名必须是 ' + [...CORE_SECTION_NAMES].join(' / ') + ' 之一（收到「' + section + '」）。');
  }
  // 用户正文里的二级标题降级成三级：否则写回去会被当成新分节，下次编辑只改到前半段。
  const bodyText = text.replace(/^##\s+/gm, '### ');
  try {
    // 进程内队列挡不住第二个 DSH 实例：MEMORY.md 的读-改-写必须拿跨进程锁。
    return await enqueue(() => withFileLock(corePath(), async () => {
      let raw = null;
      try { raw = await readFile(corePath(), 'utf8'); } catch (e) {
        // 读失败 ≠ 没有记忆：只有 ENOENT 才从模板起步，其它错误直接报错，绝不覆盖原文件。
        if (!e || e.code !== 'ENOENT') throw e;
      }
      const parsed = parseCoreSections(raw !== null ? raw : TEMPLATE);
      const target = parsed.sections.find((s) => s.title.toLowerCase() === section.toLowerCase());
      const titles = parsed.sections.map((s) => s.title).join('、') || '（无）';
      if (action === 'remove') {
        if (!target) return failMessage('E_NOT_FOUND', '删除失败：找不到分节「' + section + '」。现有分节：' + titles);
        parsed.sections = parsed.sections.filter((s) => s !== target);
      } else if (action === 'append') {
        if (target) target.body = (target.body.replace(/\s+$/, '') ? target.body.replace(/\s+$/, '') + '\n' : '') + bodyText;
        else parsed.sections.push({ title: section, body: bodyText });
      } else {
        if (!target) return failMessage('E_NOT_FOUND', '替换失败：找不到分节「' + section + '」。现有分节：' + titles);
        target.body = bodyText;
      }
      const next = renderCore(parsed);
      await atomicWrite(corePath(), next);
      const verb = action === 'append' ? '追加' : (action === 'replace' ? '替换' : '删除');
      const warn = next.length > CORE_BUDGET ? '（警告：核心记忆已超 ' + CORE_BUDGET + ' 字，注入时会被截断，建议尽快精简）' : '';
      return '已' + verb + '核心记忆分节「' + section + '」。当前核心记忆 ' + next.length + ' 字符。' + warn;
    }));
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

async function brief(graphStats, agent, bridge) {
  try {
    const core = readFileLoose(corePath());
    const notes = await loadIndex();
    const persona = readPersona();
    const lines = [];
    lines.push('记忆体检');
    lines.push('- 核心记忆 MEMORY.md：' + (core === null ? '缺失' : core.length + ' 字符 / ' + parseCoreSections(core).sections.length + ' 个分节'));
    if (core && core.length > CORE_BUDGET) lines.push('  ! 已超过建议的 ' + CORE_BUDGET + ' 字（' + core.length + ' 字符），注入时会被截断，建议尽快精简');
    const withTags = notes.filter((n) => n.tags && n.tags.length).length;
    const superseded = notes.filter((n) => n.supersededBy).length;
    const sensitiveCount = notes.filter((n) => n.sensitive).length;
    lines.push('- 归档记忆：' + notes.length + ' 条（' + withTags + ' 条带标签' +
      (superseded ? '，' + superseded + ' 条已被取代' : '') +
      (sensitiveCount ? '，' + sensitiveCount + ' 条敏感已隐藏' : '') + '）');
    lines.push('  最近 5 条：');
    for (const n of notes.slice(0, 5)) lines.push('  - [' + n.id + '] ' + n.title);
    lines.push('- 回复风格：' + (persona.enabled ? persona.preset : '（未启用）'));
    try {
      const snap = await latestSnapshot();
      lines.push(snap
        ? '- 快照：' + snap.count + ' 份（最近 ' + snap.name.slice(0, 10) + '）'
        : '- 快照：（尚未生成）');
    } catch { /* 快照不可用就省略这一行 */ }
    if (graphStats && agent) {
      try {
        const stats = await graphStats(agent);
        if (stats) {
          const parts = [];
          if (stats.nodes != null) parts.push('节点 ' + stats.nodes);
          if (stats.edges != null) parts.push('边 ' + stats.edges);
          if (stats.bytes != null) parts.push('正文 ' + (stats.bytes / 1024).toFixed(1) + 'KB');
          if (parts.length) lines.push('- 会话图谱：' + parts.join('，'));
        }
      } catch { /* 图谱不可用时省略这一行 */ }
    }
    if (bridge && bridge.enabled !== false) {
      try {
        const st = await biliStatus({ sessionsDir: bridge.sessionsDir, maxSessions: bridge.maxSessions });
        if (st.found) {
          lines.push('- billion-context：' + st.sessions + ' 个会话 / ' + st.blocks + ' 个压缩块 / 摘要 ' + st.chars + ' 字符' +
            (st.latest ? '（最近 ' + st.latest.toISOString().slice(0, 10) + '）' : ''));
        } else {
          lines.push('- billion-context：桥接已开，未找到会话存档（' + st.dir + '）');
        }
      } catch { /* 桥接不可用时省略这一行 */ }
    }
    lines.push('');
    lines.push('用法：memory_search 查归档；soul_recall 查会话过程；memory_core 改常驻；persona 改风格。');
    return lines.join('\n');
  } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
}

const outputText = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

/**
 * 注册核心记忆层。
 * @param {object} ctx 插件上下文
 * @param {object} hooks
 * @param {(agent: object, query: string) => Promise<Array<{kind: string, claim: string}>>} [hooks.graphSearch]
 * @param {(agent: object) => Promise<object>} [hooks.graphStats]
 */
export function registerCoreMemory(ctx, { graphSearch = null, graphStats = null, coding = null, lessons = null, bridge = null, core = true } = {}) {
  const bridgeCfg = bridge && typeof bridge === 'object' ? bridge : null;
  // 核心记忆层可单独关闭（memory.enabled=false）：工具、注入节、风格路由、bootstrap 一起停，
  // 编码规范与踩坑记录层各有独立开关，不受影响。
  if (core) enqueue(async () => {
    await mkdir(notesDir(), { recursive: true });
    if (readFileSyncOrNull(corePath()) === null) {
      // 已经在 enqueue 队列里，不能再 enqueue（会自己等自己）；跨进程用文件锁即可。
      await withFileLock(corePath(), async () => {
        if (readFileSyncOrNull(corePath()) === null) await atomicWrite(corePath(), TEMPLATE);
      });
    }
    // 索引必须存在：没有索引时注入/检索都读不到归档。创建动作放进索引锁内，
    // 避免并发写被这份空索引覆盖。
    await withIndexLock(async () => {
      if (readFileSyncOrNull(indexPath()) === null) {
        await atomicWrite(indexPath(), JSON.stringify({ version: 1, notes: [] }, null, 2));
      }
    });
    // 索引与 notes/ 对账：补齐外部新增、标记文件缺失、收口墓碑。
    try { await reconcileIndex(); } catch { /* 对账失败不阻塞启动 */ }
    try { await snapshotMemory(); } catch { /* 快照失败不影响启动 */ }
  }).catch((e) => console.error('dsh-x-memory: bootstrap failed', e));

  const defs = [
    {
      name: 'memory_write',
      description: '保存一条归档记忆（episodic note），跨所有会话持久。适用：用户偏好/纠正、项目决策、环境事实、重要结论等未来会话可能需要的内容。内容要自包含（未来会话看不到当前对话）。疑似重复时不会写入，会返回已有候选；确认要新增时带 force=true；若是修正某条旧记忆（而不是新增），带 supersedes=<旧 id>，旧条目会被标记为「已被取代」。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          title: { type: 'string', description: '简短标题（用于生成文件名与检索）' },
          content: { type: 'string', description: '记忆正文，自包含，可多行 Markdown' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签数组，便于检索' },
          force: { type: 'boolean', description: '已确认不是重复时传 true，跳过重复检查' },
          supersedes: { type: 'string', description: '可选：被这条新记忆取代的旧记忆 id（旧条目会被标记为已被取代，不删除）' },
        },
        required: ['title', 'content'],
      },
      execute: writeNote,
    },
    {
      name: 'memory_core',
      description: '编辑核心记忆 MEMORY.md——它在每个会话的系统提示里常驻注入，务必保持精炼。action=append 在指定分节末尾追加要点；action=replace 用 text 整体替换指定分节；action=remove 删除指定分节。适合：用户画像/偏好、环境事实、项目约定这类需要"每次都记得"的长期信息。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['append', 'replace', 'remove'], description: 'append=追加到分节末尾；replace=整体替换分节；remove=删除分节' },
          section: { type: 'string', description: '分节名（MEMORY.md 里的 ## 标题），如：用户 / 环境 / 项目' },
          text: { type: 'string', description: '要写入的内容（append/replace 时必填）' },
        },
        required: ['action', 'section'],
      },
      execute: editCore,
    },
    {
      name: 'memory_search',
      description: '按关键词检索持久记忆：归档记忆（标题/标签/正文，按相关度+新鲜度排序），并在会话图谱里补一轮同类节点。需要回忆过往会话保存的细节时主动使用。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          query: { type: 'string', description: '检索关键词，可多个（空格分隔）' },
          limit: { type: 'integer', description: '最多返回条数，默认 8' },
        },
        required: ['query'],
      },
      execute: (args, exec) => searchNotes(args, graphSearch, exec?.agent ?? null, bridgeCfg),
    },
    {
      name: 'memory_read',
      description: '按 id 读取一条归档记忆的完整内容。id 来自 memory_list / memory_search 的结果（或注入索引里的 [id]）。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', description: '记忆 id（可带 .md 后缀；支持唯一前缀匹配）' } },
        required: ['id'],
      },
      execute: (args) => readNote(typeof args.id === 'string' ? args.id.trim() : ''),
    },
    {
      name: 'memory_list',
      description: '列出归档记忆（新→旧），可按标签过滤。用于浏览记忆库全貌。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 15' },
          tag: { type: 'string', description: '可选：只列带此标签的记忆' },
        },
        required: [],
      },
      execute: listNotes,
    },
    {
      name: 'memory_delete',
      description: '删除一条归档记忆：从索引移除并把文件改写为墓碑占位。用于清理过时或错误的记忆。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: { id: { type: 'string', description: '要删除的记忆 id' } },
        required: ['id'],
      },
      execute: (args) => deleteNote(typeof args.id === 'string' ? args.id.trim() : ''),
    },
    {
      name: 'memory_brief',
      description: '一次返回记忆库体检：核心记忆大小与分节、归档条数与最近 5 条、回复风格、会话图谱规模。判断"我记住了什么/记忆是不是健康"时先调它，不要逐个工具试。',
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      execute: (_args, exec) => brief(graphStats, exec?.agent ?? null, bridgeCfg),
    },
    {
      name: 'persona',
      description: '读取或设置 AI 的回复风格（与 MEMORY.md 并列的持久偏好，注入每个会话的系统提示）。action=get 查看当前风格与全部预设；action=set 切换到某个预设；action=custom 写入自定义风格文本；action=disable 停用风格注入。仅在用户明确要求改变回复风格、或表达长期语气偏好时调用。',
      parameters: {
        type: 'object', additionalProperties: false,
        properties: {
          action: { type: 'string', enum: ['get', 'set', 'custom', 'disable'], description: 'get=查看；set=切预设；custom=写自定义；disable=停用' },
          preset: { type: 'string', description: 'action=set 时的预设 id，如 warm / concise / rigorous / humorous / gentle / default' },
          text: { type: 'string', description: 'action=custom 时的风格正文（建议 200 字内，上限 ' + MAX_CUSTOM_TEXT + ' 字符）' },
          enabled: { type: 'boolean', description: '可选：显式启用/停用风格注入；不传则保留当前启用状态' },
        },
        required: ['action'],
      },
      async execute(args) {
        const action = args.action;
        try {
          if (action === 'get') {
            const state = readPersona();
            const current = state.enabled
              ? (state.preset === 'custom' ? '自定义' : ((PRESETS.find((p) => p.id === state.preset) || {}).name || state.preset))
              : '（已停用）';
            return '当前回复风格：' + current +
              (state.enabled && state.preset === 'custom' && state.custom ? '（正文 ' + state.custom.length + ' 字符）' : '') +
              '\n生效文本：' + (buildPersonaText() || '（默认：不注入风格指令）') +
              '\n\n可选预设：\n' + PRESETS.map((p) => '- ' + p.id + '（' + p.name + '）：' + p.summary).join('\n') +
              '\n\n提示：改动将在下一次模型组装时生效。';
          }
          if (action === 'disable' && typeof args.enabled === 'boolean' && args.enabled) {
            return failMessage('E_ARG', '设置失败：action=disable 与 enabled=true 冲突，请改用 action=set。');
          }
          if (action === 'disable') {
            return await enqueue(() => withFileLock(personaPath(), async () => {
              const cur = readPersona();
              await atomicWrite(personaPath(), renderPersonaFile({ enabled: false, preset: cur.preset, custom: cur.custom }));
              return '已停用回复风格注入（预设选择「' + cur.preset + '」已保留，重新启用即可恢复）。';
            }));
          }
          if (action !== 'set' && action !== 'custom') {
            return '设置失败：action 必须是 get / set / custom / disable。\n[err:E_ARG]';
          }
          const wantPreset = action === 'custom' ? 'custom' : (typeof args.preset === 'string' ? args.preset.trim() : '');
          // 显式传了 preset 却是空白：这是参数错误，不能当成「只改 enabled」静默成功。
          if (action === 'set' && typeof args.preset === 'string' && !wantPreset) {
            return failMessage('E_ARG', '设置失败：preset 不能为空。可用预设：' + PRESETS.map((p) => p.id).join(' / '));
          }
          // set 允许只改启用状态（preset 继承当前值）；既没 preset 也没 enabled 才是参数错误。
          if (action === 'set' && !wantPreset && typeof args.enabled !== 'boolean') {
            return failMessage('E_ARG', '设置失败：action=set 需要提供 preset 或 enabled。可用预设：' + PRESETS.map((p) => p.id).join(' / '));
          }
          const patch = { preset: wantPreset };
          if (action === 'custom') patch.custom = typeof args.text === 'string' ? args.text : '';
          return await enqueue(() => withFileLock(personaPath(), async () => {
            const cur = readPersona();
            // 只有 action=custom 才把 custom 当显式入参；切预设时继承的旧正文可能超过 4000 字，
            // 不能塞进 patch 让校验把它当新写入拒掉（否则 6000 字的用户永远切不了预设）。
            // enabled 显式优先；不传时保留当前状态（set 不再静默启用，custom 也不再硬编码 true）。
            const wantEnabled = typeof args.enabled === 'boolean' ? args.enabled : cur.enabled;
            const incoming = action === 'custom'
              ? { enabled: wantEnabled, preset: 'custom', custom: patch.custom }
              : patch.preset ? { enabled: wantEnabled, preset: patch.preset } : { enabled: wantEnabled };
            const check = normalizePersonaInput(incoming, cur);
            if (!check.ok) return '设置失败：' + check.error + '\n[err:E_ARG]';
            await atomicWrite(personaPath(), renderPersonaFile(check.value));
            const preset = PRESETS.find((p) => p.id === check.value.preset);
            const label = preset ? preset.name : check.value.preset;
            return check.value.enabled
              ? '已切换回复风格为「' + label + '」。已在后续模型组装中生效。'
              : '已保存预设「' + label + '」，但风格注入仍处于停用状态（enabled: false），当前不会注入；需要时传 enabled=true 或在设置页重新启用。';
          }));
        } catch (e) { return failMessage('E_INTERNAL', errText(e)); }
      },
    },
  ];

  if (core) for (const def of defs) {
    ctx.tools.register({
      name: def.name,
      description: def.description,
      parameters: def.parameters,
      output: outputText,
      execute: def.execute,
    });
  }

  if (core) ctx.systemPrompt.section({
    name: 'dsh-x-memory:recall',
    order: 60,
    // 记忆正文可能包含 {{...}}；关掉模板插值，避免用户内容被当成提示模板执行。
    interpolate: false,
    text: () => buildSectionText(),
  });

  // 设置页读写接口：风格页经同源 fetch 调用。webServer 是可选依赖。
  if (core) ctx.inject(['webServer'], (c) => {
    c.effect(() => c.webServer.register({
      kind: 'exact',
      path: '/dsh-x-memory/persona',
      async handler(req, res) {
        const sendJson = (code, payload) => {
          try {
            const body = JSON.stringify(payload);
            res.statusCode = code;
            res.setHeader('content-type', 'application/json; charset=utf-8');
            // 风格设置属于个人数据，禁止任何缓存。
            res.setHeader('cache-control', 'no-store');
            res.end(body);
          } catch { /* 响应已发出时忽略 */ }
        };
        try {
          // Host 必须是本机回环：只比 Origin 与 Host 挡不住 DNS rebinding——
          // 恶意域名解析到 127.0.0.1 后，Origin 与 Host 都是它自己的名字，仍然“同源”。
          const host = String(req.headers.host || '').toLowerCase();
          if (host) {
            const hostName = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
            if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostName)) {
              sendJson(403, { error: '仅允许本机页面访问' });
              return;
            }
          }
          // 方法先判：浏览器预检必带跨源 Origin，若先查 Origin，405 + Allow 永远不可达。
          if (req.method !== 'GET' && req.method !== 'POST') {
            res.setHeader('Allow', 'GET, POST');
            sendJson(405, { error: '仅支持 GET / POST' });
            return;
          }
          // 只接受同源页面调用：带 Origin 时必须与 Host 一致（跨站请求一律拒绝）。
          const origin = req.headers.origin;
          if (origin) {
            let sameOrigin = false;
            try { sameOrigin = new URL(origin).host === req.headers.host; } catch { sameOrigin = false; }
            if (!sameOrigin) { sendJson(403, { error: '跨源请求被拒绝' }); return; }
          }
          // 同源页面必须带自定义请求头：跨站表单/链接无法伪造，且会触发 CORS 预检，挡住跨源读取。
          if (String(req.headers['x-dsh-x-memory'] || '') !== '1') {
            sendJson(403, { error: '缺少 X-DSH-X-Memory: 1 请求头' });
            return;
          }
          if (req.method === 'POST') {
            // 浏览器跨站表单只能发 urlencoded/plain，要求 JSON 也就挡住了 CSRF 表单。
            const ctype = String(req.headers['content-type'] || '').toLowerCase();
            if (!ctype.startsWith('application/json')) {
              sendJson(415, { error: 'Content-Type 必须是 application/json' });
              return;
            }
            const bodyRes = await readBody(req);
            if (bodyRes.tooLarge) { sendJson(413, { error: '请求体过大（上限 16KB）' }); return; }
            const patch = safeJson(bodyRes.body || '{}', null);
            if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
              sendJson(400, { error: '请求体必须是 JSON 对象' });
              return;
            }
            // 只接受已知字段且类型正确：拼错的字段名（presett）静默 200 会让调用方以为生效了。
            const ALLOWED_FIELDS = new Set(['preset', 'custom', 'enabled']);
            for (const [key, value] of Object.entries(patch)) {
              if (!ALLOWED_FIELDS.has(key)) { sendJson(400, { error: '不支持的字段：' + key }); return; }
              if (key === 'custom' && typeof value !== 'string') { sendJson(400, { error: 'custom 必须是字符串' }); return; }
              if (key === 'preset' && typeof value !== 'string') { sendJson(400, { error: 'preset 必须是字符串' }); return; }
              if (key === 'enabled' && typeof value !== 'boolean') { sendJson(400, { error: 'enabled 必须是布尔值' }); return; }
            }
            if (typeof patch.preset === 'string' && !patch.preset.trim()) {
              sendJson(400, { error: 'preset 不能为空' });
              return;
            }
            if (Object.keys(patch).length === 0) {
              res.setHeader('cache-control', 'no-store');
              res.statusCode = 204;
              res.end();
              return;
            }
            const result = await enqueue(() => withFileLock(personaPath(), async () => {
              const cur = readPersona();
              const check = normalizePersonaInput(patch, cur);
              if (!check.ok) return { ok: false, error: check.error };
              await atomicWrite(personaPath(), renderPersonaFile(check.value));
              return { ok: true, persona: readPersona() };
            }));
            if (!result.ok) { sendJson(400, { error: result.error }); return; }
            sendJson(200, { persona: result.persona, presets: listPresets(), maxCustom: MAX_CUSTOM_TEXT });
            return;
          }
          sendJson(200, { persona: readPersona(), presets: listPresets(), maxCustom: MAX_CUSTOM_TEXT });
        } catch (error) {
          // 校验失败是 400；写盘失败/内部异常必须 500，否则设置页会把"服务器写不进去"显示成"参数不对"。
          console.error('dsh-x-memory: 风格接口内部错误', error);
          sendJson(500, { error: '服务器内部错误：' + ((error && error.message) ? error.message : String(error)) });
        }
      },
    }), 'dsh-x-memory: persona settings route');
  });

  // 编码规范层：独立的 section（order 61），与 MEMORY.md 的预算互不挤占。
  try {
    registerCodingRules(ctx, coding ?? {});
  } catch (e) {
    console.error('dsh-x-memory: 编码规范层注册失败', e);
  }

  // 自动踩坑记录：工具报错后同会话恢复时记一条，注入 order 62 的 section。
  try {
    registerLessons(ctx, lessons ?? {});
  } catch (e) {
    console.error('dsh-x-memory: 踩坑记录层注册失败', e);
  }

  console.log('dsh-x-memory: 核心记忆层已激活，记忆库 ' + memoryPath());
}
