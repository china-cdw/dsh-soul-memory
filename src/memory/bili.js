// dsh-x-memory ↔ billion-context 桥接层
//
// 只读、永不写 billion-context 的数据；解析失败一律降级为空，绝不影响记忆层。
//
// 数据来源：billion-context 每个会话把压缩状态写到
//   <sessionsDir>/<protocol>/api.<host>_<hash>.json
// 文件形如 { version, savedAt, id, payload: { state: { blocks: [...] }, ... } }，
// 其中 payload.state.blocks 是压缩块，字段有 blockId / tier / topic / summary /
// compressedTokens / createdAt / active 等（版本演进中可能增删，全部按可选处理）。
//
// 设计取舍：
//   - 不读 index.db（schema 属内部实现，且可能被写锁占用）；只读 JSON 副本。
//   - 按 mtime+size 缓存解析结果：同一会话没变就不重复解析 4MB 的 JSON。
//   - 单个文件超过 8MB 直接跳过，避免一次搜索拖慢一轮对话。
import { readdirSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 3;
/** 单次注入的摘要上限（保守，避免把上下文又撑大）。 */
const DEFAULT_MAX_CHARS = 1200;

/** 解析后的块缓存：绝对路径 → { mtimeMs, size, entries } */
const cache = new Map();

export function biliSessionsDir(explicit) {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const env = process.env.BILI_SESSIONS_DIR;
  if (typeof env === 'string' && env.trim()) return env.trim();
  return join(homedir(), '.local', 'share', 'billion-context', 'sessions');
}

function collectJsonFiles(dir, out, depth) {
  if (depth > MAX_DEPTH) return;
  let items;
  try {
    items = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const item of items) {
    const abs = join(dir, item.name);
    if (item.isDirectory()) {
      collectJsonFiles(abs, out, depth + 1);
    } else if (item.isFile() && item.name.toLowerCase().endsWith('.json')) {
      out.push(abs);
    }
  }
}

async function loadSessionFile(file) {
  const st = await stat(file);
  if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) return [];
  const hit = cache.get(file);
  const mtimeSec = Math.floor(st.mtimeMs / 1000);
  if (hit && hit.mtimeSec === mtimeSec && hit.size === st.size) return hit.entries;

  const raw = await readFile(file, 'utf8');
  const doc = JSON.parse(raw);
  const payload = (doc && doc.payload) || {};
  const state = (payload.state) || {};
  const blocks = Array.isArray(state.blocks) ? state.blocks : [];
  const sessionId = String(doc.id || payload.id || '');
  const savedAt = Number(doc.savedAt || payload.savedAt || 0);
  const entries = [];
  for (const b of blocks) {
    if (!b || b.active === false) continue;
    const summary = typeof b.summary === 'string' ? b.summary.trim() : '';
    if (!summary) continue;
    entries.push({
      file,
      sessionId,
      savedAt,
      blockId: String(b.blockId || ''),
      tier: Number(b.tier) || 1,
      topic: String(b.topic || '').trim(),
      summary,
      tokens: Number(b.compressedTokens) || 0,
      createdAt: Number(b.createdAt) || 0,
    });
  }
  entries.sort((a, b) => b.createdAt - a.createdAt);
  cache.set(file, { mtimeSec, size: st.size, entries });
  return entries;
}

/** 读取最近 maxSessions 个会话的压缩块（失败返回 []）。 */
export async function readBiliBlocks(opts = {}) {
  const maxSessions = clampInt(opts.maxSessions, 1, 50, 4);
  const maxBlocks = clampInt(opts.maxBlocksPerSession, 1, 50, 5);
  const dir = biliSessionsDir(opts.sessionsDir);
  const files = [];
  collectJsonFiles(dir, files, 0);
  if (!files.length) return [];
  const withTime = [];
  for (const file of files) {
    try {
      const st = await stat(file);
      withTime.push({ file, mtimeMs: st.mtimeMs });
    } catch { /* 文件消失就跳过 */ }
  }
  withTime.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const item of withTime.slice(0, maxSessions)) {
    try {
      const entries = await loadSessionFile(item.file);
      if (entries.length) out.push({ file: item.file, mtimeMs: item.mtimeMs, entries: entries.slice(0, maxBlocks) });
    } catch { /* 单个文件坏掉不影响其它会话 */ }
  }
  return out;
}

/** 体检一行用：会话数、块数、摘要总字符、最近时间。 */
export async function biliStatus(opts = {}) {
  const sessions = await readBiliBlocks(opts);
  let blocks = 0;
  let chars = 0;
  let latest = 0;
  for (const s of sessions) {
    blocks += s.entries.length;
    for (const e of s.entries) {
      chars += e.summary.length;
      latest = Math.max(latest, e.createdAt, s.mtimeMs);
    }
  }
  return {
    dir: biliSessionsDir(opts.sessionsDir),
    found: blocks > 0,
    sessions: sessions.length,
    blocks,
    chars,
    latest: latest ? new Date(latest) : null,
  };
}

/** 检索：返回 { text, count }；没有命中返回空串。 */
export async function searchBili(query, opts = {}) {
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { text: '', count: 0 };
  const maxChars = clampInt(opts.maxChars, 200, 4000, DEFAULT_MAX_CHARS);
  const terms = queryTerms(q);
  if (!terms.length) return { text: '', count: 0 };

  const sessions = await readBiliBlocks(opts);
  const hits = [];
  for (const s of sessions) {
    for (const e of s.entries) {
      const hay = (e.topic + '\n' + e.summary).toLowerCase();
      let score = 0;
      for (const t of terms) if (hay.includes(t)) score += 1;
      if (score === 0) continue;
      hits.push({ entry: e, score });
    }
  }
  if (!hits.length) return { text: '', count: 0 };
  hits.sort((a, b) => (b.score - a.score) || (b.entry.createdAt - a.entry.createdAt));

  let budget = maxChars;
  const lines = [];
  for (const h of hits) {
    const e = h.entry;
    const head = '- ' + shortDate(e.createdAt) + ' [t' + e.tier + '] ' + (e.topic || '（无标题）') + '：';
    const room = Math.max(80, budget - head.length - 24);
    const body = oneLine(e.summary).slice(0, room) + (e.summary.length > room ? '…' : '');
    const line = head + body;
    if (line.length > budget) break;
    lines.push(line);
    budget -= line.length + 1;
  }
  if (!lines.length) return { text: '', count: 0 };
  return {
    count: lines.length,
    text: '【历史会话摘要（billion-context，只读）】' + lines.length + ' 条相关压缩块（需要原文用 decompress 或 soul_recall 展开）：\n' + lines.join('\n'),
  };
}

function queryTerms(q) {
  const set = new Set();
  const lower = q.toLowerCase();
  for (const t of lower.split(/[\s,，、;；。!！?？:：()（）[\]【】"']+/)) {
    if (t.length >= 2) set.add(t);
  }
  for (const run of lower.match(/[\u4e00-\u9fff]{2,}/g) || []) {
    for (let i = 0; i + 2 <= run.length; i++) set.add(run.slice(i, i + 2));
  }
  return [...set].slice(0, 24);
}

function oneLine(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function shortDate(ms) {
  if (!ms) return '未知时间';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}
