// dsh-soul-memory — 编码规范固定记忆层
//
// 目标：让"怎么写代码"这类规则跨会话固定下来，而不是每次靠人重复。
// 两个来源，一起注入（有字节预算，超了就截断并注明）：
//   1) 全局：<dshHome>/memory/CODING.md —— 你认可的通用编码/工程习惯，任何项目都生效；
//   2) 项目：当前工作目录下的 AGENTS.md / CLAUDE.md / .cursorrules /
//      .cursor/rules/*.mdc / .github/copilot-instructions.md / .dsh/rules.md / CODING.md。
// 工具 coding_rules 负责写全局层：add（用户已明确认可，直接写）/ forget / list / show；
// propose / pending / approve / reject 是「人批准」的晋升通道——模型自己归纳的规则先进
// memory/CODING.pending.json，用户批准后才写进 CODING.md 并开始注入。
//
// 设计参考：AGENTS.md 约定（https://agents.md/）、Cursor rules、以及 dsh-meow-memory 的
// rules 层——但这里不做检索/嵌入，只做"小而常驻"，避免和 MEMORY.md 抢预算。
import { createHash } from 'node:crypto';
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, createQueue, memoryHome, sliceSafe, withFileLock } from './memory/util.js';
import { withNotes } from './tool-notes.js';

// 每轮系统提示都要重发这段规则，所以有预算上限；超出会截断。
// 3500 是默认值，不是硬限制：插件配置 coding.budget 可调 400–8000。
const DEFAULT_BUDGET = 3500;
const FILE_CHAR_CAP = 6000;
const MAX_RULE_TEXT = 2000;
const MAX_DIR_FILES = 20;
const PENDING_FILE = 'CODING.pending.json';
const MAX_PENDING = 20;

// 「晋升门槛」——同一段文字留给三处用：文件模板、注入头部、工具描述。
// 只写一次，避免三份文案各自漂移。
const GATE = '晋升门槛：跨项目适用（不是某个项目的临时约定）、至少复现过两次、说得出什么场景必须遵守；只出现一次的不进全局。';
const GATE_SHORT = '用户当场明确要求的用 add 直接写；你自己归纳的用 propose 进待批，用户批准后才注入。';

const PROJECT_FILES = [
  ['CODING.md', '项目 CODING.md'],
  ['AGENTS.md', 'AGENTS.md'],
  ['CLAUDE.md', 'CLAUDE.md'],
  ['.cursorrules', '.cursorrules'],
  [join('.github', 'copilot-instructions.md'), 'Copilot 指令'],
  [join('.dsh', 'rules.md'), '.dsh/rules.md'],
];
const CURSOR_RULES_DIR = join('.cursor', 'rules');

const TEMPLATE = [
  '# 编码规范（全局）',
  '',
  '> dsh-soul-memory 的固定记忆层：以下规则注入每个会话的系统提示（有预算上限），跨项目生效。',
  '> ' + GATE,
  '> 用 coding_rules action=add 追加（用户已认可）；action=propose 提议（待用户批准）；',
  '> action=list 查看；action=forget 删除；action=show 看当前实际注入内容。',
  '',
  '## 规则',
  '',
].join('\n');

export function codingPath() {
  return join(memoryHome(), 'memory', 'CODING.md');
}

// ---------- 读文件 ----------
function readCapped(path, cap = FILE_CHAR_CAP, { strict = false } = {}) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    let text = readFileSync(path, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) return null;
    // cap=Infinity 表示「写回用的完整读取」：截断只用于注入与展示，绝不能拿截断文本回写。
    if (Number.isFinite(cap) && text.length > cap) text = sliceSafe(text, cap) + '\n…（文件过长，已截断）';
    return text;
  } catch (e) {
    // 只有「文件不存在」才代表没有内容；占用/权限等读错误必须让调用方知道，
    // 否则写回路径会把规则文件当成空文件、用模板覆盖掉全部规则。
    if (e && e.code === 'ENOENT') return null;
    if (strict) throw e;
    return null;
  }
}

function listCursorRules(cwd) {
  const dir = join(cwd, CURSOR_RULES_DIR);
  try {
    const names = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isFile() && /\.(mdc|md)$/i.test(e.name))
      .map((e) => e.name)
      .sort()
      .slice(0, MAX_DIR_FILES);
    return names.map((name) => ({ path: join(dir, name), label: `.cursor/rules/${name}` }));
  } catch {
    return [];
  }
}

function projectSources(cwd) {
  const out = [];
  for (const [rel, label] of PROJECT_FILES) {
    const path = join(cwd, rel);
    if (statSyncSafe(path)) out.push({ path, label });
  }
  out.push(...listCursorRules(cwd));
  return out;
}

function statSyncSafe(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// ---------- 组装 ----------
/**
 * 收集并裁剪规则文本。
 * @returns {{ text: string, files: Array<{label: string, path: string, chars: number}>, used: number, budget: number }}
 */
export function collectRules(cwd, { budget = DEFAULT_BUDGET, globalText = null } = {}) {
  const chunks = [];
  const global = globalText ?? readCapped(codingPath());
  if (global) chunks.push({ label: '全局编码规范（CODING.md）', path: codingPath(), body: global });
  if (cwd) {
    for (const src of projectSources(cwd)) {
      const body = readCapped(src.path);
      if (body) chunks.push({ label: src.label, path: src.path, body });
    }
  }

  const lines = [];
  const files = [];
  const headLines = [
    '# 编码规范（dsh-soul-memory）',
    '',
    '以下是本机与当前项目的编码约定。写代码、改文件时遵守；与用户当轮明确指令冲突时以用户为准。',
    '用户当场明确要求的规则，用 coding_rules action=add 直接写；你自己归纳的用 action=propose 进待批，用户批准后才注入。',
    GATE,
    '',
  ];
  const pendingCount = countPending();
  if (pendingCount) headLines.push(`- 待批规则 ${pendingCount} 条：用 coding_rules action=pending 查看，approve 后才会注入。`);
  if (budget < 800) {
    headLines.push('（预算提示：编码规范注入预算只有 ' + budget + ' 字，规则会被大幅截断；可在插件设置里调大 coding.budget。）', '');
  }
  const head = headLines.join('\n');
  const room = Math.max(120, budget - head.length - 1);
  let used = 0;
  let truncated = false;

  for (const chunk of chunks) {
    const header = `## ${chunk.label}`;
    const block = `${header}\n\n${chunk.body}`;
    const cost = block.length + (lines.length ? 2 : 0);
    if (used + cost > room) {
      const note = `\n…（已按 ${budget} 字预算截断）`;
      const avail = room - used - (lines.length ? 2 : 0) - header.length - 2 - note.length;
      if (avail > 80) {
        const cut = sliceSafe(chunk.body, avail);
        lines.push(`${header}\n\n${cut}\n…（已按 ${budget} 字预算截断）`);
        files.push({ label: chunk.label, path: chunk.path, chars: cut.length });
        truncated = true;
      }
      break;
    }
    lines.push(block);
    files.push({ label: chunk.label, path: chunk.path, chars: chunk.body.length });
    used += cost;
  }

  // 一条正式规则都没有时通常不注入以省 token；但有待批规则时必须注入头部，
  // 否则用户永远看不到「有待批规则」这条提示。
  if (!lines.length && !pendingCount) return { text: '', files, used: 0, budget, truncated: false };
  const text = head + (lines.length ? lines.join('\n\n') : '');
  return { text, files, used: text.length, budget, truncated };
}

// ---------- 写全局层 ----------
const enqueue = createQueue();

/** 规则用量一行话：写规则、批准规则、查看规则时都能看到还剩多少。 */
export function usageLine(gathered) {
  const used = gathered.used;
  const budget = gathered.budget;
  const pct = budget ? Math.round((used / budget) * 100) : 0;
  const remain = Math.max(0, budget - used);
  const warn = used >= budget * 0.85
    ? ` ⚠️ 已用 ${pct}%，快到 ${budget} 字上限：再加规则会被截断，先合并或删掉旧规则。`
    : '';
  return `— 编码规范：${used}/${budget} 字（${pct}%，剩 ${remain} 字）。${warn}`;
}

/** 比较用 2-gram：去掉代码片段、空白与标点，中文按字、英文按字符都能量。 */
function gramsOf(text) {
  const s = String(text ?? '')
    .replace(/`[^`]*`/g, '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
  if (s.length === 1) set.add(s);
  return set;
}

/**
 * 找出与 rule 措辞相近的已有规则（2-gram Jaccard）。只提示、不阻塞写入：
 * 是否真的同一件事要人判断，这里只负责「这两条像」。
 */
export function similarRules(rule, others, { threshold = 0.3, limit = 3 } = {}) {
  const base = gramsOf(rule);
  if (!base.size) return [];
  const mine = ruleKey(rule);
  const hits = [];
  for (const other of others) {
    const text = typeof other === 'string' ? other : other && other.rule;
    if (!text || ruleKey(text) === mine) continue;
    const set = gramsOf(text);
    if (!set.size) continue;
    let inter = 0;
    for (const g of base) if (set.has(g)) inter++;
    const jaccard = inter / (base.size + set.size - inter);
    // 一条是另一条的扩写时 Jaccard 会被句长稀释；覆盖度补上这个盲区。
    // 短句不享受覆盖度加成——样本太小，几个字重合就能刷到 0.8。
    const small = Math.min(base.size, set.size);
    const containment = small >= 8 ? inter / small : 0;
    const score = Math.max(jaccard, containment);
    if (score >= threshold) hits.push({ rule: text, score: Math.round(score * 100) / 100 });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

/** 从 CODING.md 的行里取顶层规则（缩进的 why / 陷阱 子行不算）。 */
function rulesOfLines(lines) {
  const out = [];
  for (const line of lines) {
    const m = /^-\s+(.*\S)\s*$/.exec(line);
    if (m) out.push({ rule: m[1] });
  }
  return out;
}

/** 文件里的正式规则列表；读失败返回空（供 dupes 扫描用）。 */
export function readGlobalRules() {
  let text;
  try {
    text = readCapped(codingPath(), Infinity, { strict: true }) ?? '';
  } catch {
    return [];
  }
  return rulesOfLines(text.split('\n'));
}

/** 读全局规则连同它的子行（为什么 / 陷阱），供设置页逐条编辑用。 */
export function readGlobalRuleBlocks() {
  let text;
  try {
    text = readCapped(codingPath(), Infinity, { strict: true });
  } catch {
    return [];
  }
  if (!text) return [];
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const m = lines[i].match(/^\s*-\s*(.*)$/);
    if (!m || /^\s{2,}-\s/.test(lines[i])) continue;
    let why = '';
    let pitfall = '';
    for (let j = i + 1; j < lines.length && /^\s{2,}-\s/.test(lines[j]); j += 1) {
      const sub = lines[j].replace(/^\s{2,}-\s*/, '');
      if (sub.startsWith('为什么：')) why = sub.slice('为什么：'.length);
      else if (sub.startsWith('陷阱：')) pitfall = sub.slice('陷阱：'.length);
    }
    out.push({ text: m[1].trim(), why, pitfall });
  }
  return out;
}

function clip(text, n) {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/** 重复/可合并提示：每条只给相似度和前 30 字，别把工具输出撑长。 */
function similarHint(hits) {
  if (!hits || !hits.length) return '';
  const parts = hits.map((h) => `${h.score}：${clip(h.rule, 30)}`);
  return `⚠️ 可能与已有规则重复或可合并——${parts.join('；')}。能并成一条就合并，多余的那条用 action=forget 删掉。`;
}

function normalizeRule(text) {
  return String(text ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 比较用的键：忽略全部空白差异（中文标点后的空格不应算作另一条规则）。 */
function ruleKey(text) {
  return normalizeRule(text).replace(/\s+/g, '');
}

/**
 * 写入的核心逻辑。调用方负责持 codingPath 的锁；
 * 不要在已持队列任务里再调 addRule，嵌套 enqueue 会互相等待。
 */
async function writeRuleLocked(rule, why, pitfall) {
    const path = codingPath();
    // 写回必须基于完整文件：readCapped 的默认 cap 只用于注入，不能用来改文件。
    // strict：读失败（非 ENOENT）必须放弃写入，否则会用模板覆盖掉整份规则。
    let existing;
    try {
      existing = readCapped(path, Infinity, { strict: true }) ?? TEMPLATE;
    } catch (e) {
      return { ok: false, code: 'E_IO', error: '读取编码规范失败，为避免覆盖已放弃写入：' + (e && e.message ? e.message : e) };
    }
    const lines = existing.split('\n');
    if (lines.some((line) => ruleKey(line.replace(/^\s*-\s*/, '')) === ruleKey(rule))) {
      return { ok: false, code: 'E_DUPLICATE', error: '已有相同规则，未重复写入。' };
    }
    // 措辞不同但意思相近的：提示给调用方，让用户决定要不要合并。
    const similar = similarRules(rule, rulesOfLines(lines));
    const block = [`- ${rule}`, ...(why ? [`  - 为什么：${why}`] : []), ...(pitfall ? [`  - 陷阱：${pitfall}`] : [])];
    const idx = lines.findIndex((line) => line.trim() === '## 规则');
    if (idx >= 0) {
      let at = idx + 1;
      while (at < lines.length && lines[at].trim() === '') at++;
      lines.splice(at, 0, ...block);
    } else {
      lines.push('', '## 规则', '', ...block);
    }
    try {
      await atomicWrite(path, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
    } catch (e) {
      return { ok: false, code: 'E_IO', error: '写入编码规范失败：' + (e && e.message ? e.message : e) };
    }
    return { ok: true, rule, similar };
}

export async function addRule(text, opts = {}) {
  const rule = normalizeRule(text);
  const why = normalizeRule(opts.why || '');
  const pitfall = normalizeRule(opts.pitfall || '');
  if (why.length > 400 || pitfall.length > 400) return { ok: false, code: 'E_ARG', error: '为什么/陷阱各不能超过 400 字。' };
  if (!rule) return { ok: false, code: 'E_ARG', error: '规则内容不能为空。' };
  if (rule.length > MAX_RULE_TEXT) return { ok: false, code: 'E_ARG', error: `规则太长（${rule.length} 字），上限 ${MAX_RULE_TEXT} 字。` };
  try {
    return await enqueue(() => withFileLock(codingPath(), () => writeRuleLocked(rule, why, pitfall)));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '写入编码规范失败（文件被占用或不可写）：' + (e && e.message ? e.message : e) };
  }
}

export async function forgetRule(text) {
  const rule = normalizeRule(text);
  if (!rule) return { ok: false, code: 'E_ARG', error: '要删除的规则内容不能为空。' };
  try {
    return await enqueue(() => withFileLock(codingPath(), async () => {
    const path = codingPath();
    let existing;
    try {
      existing = readCapped(path, Infinity, { strict: true });
    } catch (e) {
      return { ok: false, code: 'E_IO', error: '读取编码规范失败，为避免破坏文件已放弃写入：' + (e && e.message ? e.message : e) };
    }
    if (!existing) return { ok: false, code: 'E_NOT_FOUND', error: '全局编码规范还是空的。' };
    const lines = existing.split('\n');
    // 顺序扫描：删掉规则行时连带删掉它缩进的「为什么 / 陷阱」子行，不留孤儿。
    const kept = [];
    let skipSub = false;
    for (const line of lines) {
      if (/^\s{2,}-\s/.test(line)) {
        if (skipSub) continue;
        kept.push(line);
        continue;
      }
      const m = line.match(/^\s*-\s*(.*)$/);
      if (m) {
        if (ruleKey(m[1]) === ruleKey(rule)) { skipSub = true; continue; }
        skipSub = false;
      }
      kept.push(line);
    }
    const removed = lines.length - kept.length;
    if (!removed) return { ok: false, code: 'E_NOT_FOUND', error: '没有找到完全匹配的规则；先 action=list 看一眼。' };
    try {
      await atomicWrite(path, kept.join('\n'));
    } catch (e) {
      return { ok: false, code: 'E_IO', error: '写入编码规范失败：' + (e && e.message ? e.message : e) };
    }
    return { ok: true, removed };
    }));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '写入编码规范失败（文件被占用或不可写）：' + (e && e.message ? e.message : e) };
  }
}

/**
 * 改写一条已有的全局规则：按原规则正文定位，连同它的「为什么 / 陷阱」子行一起替换。
 * 找不到原规则 → E_NOT_FOUND；改完与别的规则重复 → E_DUPLICATE。
 * 调用方持锁后调用，不要在队列任务里再调 addRule。
 */
export async function editRule(oldText, patch = {}) {
  const oldRule = normalizeRule(oldText);
  if (!oldRule) return { ok: false, code: 'E_ARG', error: '要编辑的规则内容不能为空。' };
  const rule = normalizeRule(patch.text);
  if (!rule) return { ok: false, code: 'E_ARG', error: '规则内容不能为空。' };
  if (rule.length > MAX_RULE_TEXT) return { ok: false, code: 'E_ARG', error: `规则太长（${rule.length} 字），上限 ${MAX_RULE_TEXT} 字。` };
  const why = normalizeRule(patch.why);
  const pitfall = normalizeRule(patch.pitfall);
  if (why.length > 400) return { ok: false, code: 'E_ARG', error: '「为什么」太长，上限 400 字。' };
  if (pitfall.length > 400) return { ok: false, code: 'E_ARG', error: '「陷阱」太长，上限 400 字。' };
  try {
    return await enqueue(() => withFileLock(codingPath(), async () => {
      const path = codingPath();
      let existing;
      try {
        existing = readCapped(path, Infinity, { strict: true });
      } catch (e) {
        return { ok: false, code: 'E_IO', error: '读取编码规范失败，为避免覆盖已放弃写入：' + (e && e.message ? e.message : e) };
      }
      if (!existing) return { ok: false, code: 'E_NOT_FOUND', error: '全局编码规范还是空的。' };
      const lines = existing.split('\n');
      const out = [];
      let replaced = false;
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const m = line.match(/^\s*-\s*(.*)$/);
        if (!m || /^\s{2,}-\s/.test(line)) {
          out.push(line);
          continue;
        }
        // 顶层规则行：先找出它的子行结束位置，整块替换。
        let end = i + 1;
        while (end < lines.length && /^\s{2,}-\s/.test(lines[end])) end += 1;
        if (ruleKey(m[1]) !== ruleKey(oldRule)) {
          for (let k = i; k < end; k += 1) out.push(lines[k]);
          i = end - 1;
          continue;
        }
        if (replaced) return { ok: false, code: 'E_DUPLICATE', error: '有多条相同规则，先用 action=forget 清理重复项。' };
        out.push('- ' + rule);
        if (why) out.push('  - 为什么：' + why);
        if (pitfall) out.push('  - 陷阱：' + pitfall);
        replaced = true;
        i = end - 1;
      }
      if (!replaced) return { ok: false, code: 'E_NOT_FOUND', error: '没有找到完全匹配的规则；先 action=list 看一眼。' };
      const topKeys = out
        .filter((line) => /^\s*-\s/.test(line) && !/^\s{2,}-\s/.test(line))
        .map((line) => ruleKey(line.replace(/^\s*-\s*/, '')));
      if (topKeys.filter((key) => key === ruleKey(rule)).length > 1) {
        return { ok: false, code: 'E_DUPLICATE', error: '改完会和另一条规则完全一样，先把那条删掉再改。' };
      }
      try {
        await atomicWrite(path, out.join('\n'));
      } catch (e) {
        return { ok: false, code: 'E_IO', error: '写入编码规范失败：' + (e && e.message ? e.message : e) };
      }
      const others = rulesOfLines(out).filter((item) => ruleKey(item.rule) !== ruleKey(rule));
      return { ok: true, rule, similar: similarRules(rule, others) };
    }));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '写入编码规范失败（文件被占用或不可写）：' + (e && e.message ? e.message : e) };
  }
}

// ---------- 待批（规则晋升要人批准） ----------
export function pendingPath() {
  return join(memoryHome(), 'memory', PENDING_FILE);
}

/** 读待批列表；文件不存在返回 []，内容损坏抛错——写回时不能把损坏文件当空文件覆盖。 */
function readPendingStrict() {
  let text;
  try {
    text = readFileSync(pendingPath(), 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
  if (!text.trim()) return [];
  const arr = JSON.parse(text);
  if (!Array.isArray(arr)) throw new Error('待批规则文件不是数组');
  return arr.filter((x) => x && typeof x.id === 'string' && typeof x.text === 'string');
}

function countPending() {
  try {
    return readPendingStrict().length;
  } catch {
    return 0;
  }
}

export async function proposedRules() {
  try {
    return { ok: true, list: readPendingStrict() };
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '读取待批规则失败：' + (e && e.message ? e.message : e) };
  }
}

/**
 * 提议一条规则：只进待批文件，不写 CODING.md、不注入。
 * 已在正式规则或待批列表里的同一内容返回 E_DUPLICATE（幂等，不重复排队）。
 */
export async function proposeRule(text, opts = {}) {
  const rule = normalizeRule(text);
  const why = normalizeRule(opts.why || '');
  const pitfall = normalizeRule(opts.pitfall || '');
  const source = normalizeRule(opts.source || '');
  if (!rule) return { ok: false, code: 'E_ARG', error: '规则内容不能为空。' };
  if (why.length > 400 || pitfall.length > 400) return { ok: false, code: 'E_ARG', error: '为什么/陷阱各不能超过 400 字。' };
  if (rule.length > MAX_RULE_TEXT) return { ok: false, code: 'E_ARG', error: `规则太长（${rule.length} 字），上限 ${MAX_RULE_TEXT} 字。` };
  const key = ruleKey(rule);
  try {
    return await enqueue(() => withFileLock(pendingPath(), async () => {
      const existing = readCapped(codingPath(), Infinity) || '';
      const dup = existing.split('\n').some((line) => ruleKey(line.replace(/^\s*-\s*/, '')) === key);
      if (dup) return { ok: false, code: 'E_DUPLICATE', error: '这条已经在全局编码规范里了。' };
      const list = readPendingStrict();
      if (list.some((x) => ruleKey(x.text) === key)) return { ok: false, code: 'E_DUPLICATE', error: '这条已经在待批列表里了。' };
      if (list.length >= MAX_PENDING) return { ok: false, code: 'E_FULL', error: `待批规则已达上限 ${MAX_PENDING} 条，先处理一批再提议。` };
      // 正式规则和待批里措辞相近的都提示出来，避免排队进两条意思一样的。
      const similar = [
        ...similarRules(rule, rulesOfLines(existing.split('\n'))),
        ...similarRules(rule, list.map((x) => ({ rule: x.text }))),
      ];
      const id = createHash('sha256').update(key).digest('hex').slice(0, 8);
      list.unshift({ id, text: rule, why, pitfall, source, createdAt: new Date().toISOString() });
      await atomicWrite(pendingPath(), JSON.stringify(list, null, 2));
      return { ok: true, id, count: list.length, similar };
    }));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '写入待批规则失败：' + (e && e.message ? e.message : e) };
  }
}

/** 批准：全程持待批锁（锁内重读，避免与 reject 竞态），先写进 CODING.md，再从待批移除。已存在的同内容规则视为成功（幂等重试）。 */
export async function approveRules(ids) {
  const wanted = new Set((ids || []).map((x) => String(x).trim()).filter(Boolean));
  if (!wanted.size) return { ok: false, code: 'E_ARG', error: '要给 approve 的规则 id。' };
  try {
    return await enqueue(() => withFileLock(pendingPath(), async () => {
      const list = readPendingStrict();
      const picked = list.filter((x) => wanted.has(x.id));
      if (!picked.length) return { ok: false, code: 'E_NOT_FOUND', error: '没有匹配的待批规则 id（先 action=pending 看一眼）。' };
      const applied = [];
      const failed = [];
      const similar = [];
      for (const item of picked) {
        let res;
        try {
          // 已在待批锁内，直接取 coding 锁写入；不能再走 addRule 的 enqueue，否则自锁。
          res = await withFileLock(codingPath(), () => writeRuleLocked(item.text, item.why || '', item.pitfall || ''));
        } catch (e) {
          res = { ok: false, error: e && e.message ? e.message : String(e) };
        }
        if (res.ok || res.code === 'E_DUPLICATE') applied.push(item.id);
        else failed.push({ id: item.id, error: res.error || '写入失败' });
        if (res.ok && res.similar && res.similar.length) {
          for (const hit of res.similar) similar.push({ id: item.id, rule: hit.rule, score: hit.score });
        }
      }
      if (!applied.length) {
        return { ok: false, code: 'E_IO', error: '一条都没写进 CODING.md：' + (failed[0] ? failed[0].error : '未知错误'), applied, failed };
      }
      let cleanupError = null;
      try {
        const cur = readPendingStrict();
        await atomicWrite(pendingPath(), JSON.stringify(cur.filter((x) => !applied.includes(x.id)), null, 2));
      } catch (e) {
        cleanupError = e && e.message ? e.message : String(e);
      }
      const out = { ok: true, applied, failed };
      if (similar.length) out.similar = similar;
      if (cleanupError) out.cleanupError = cleanupError;
      return out;
    }));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '批准规则失败：' + (e && e.message ? e.message : e) };
  }
}

/**
 * 改待批条目的措辞：用户批准前想修一句时用。
 * 锁内重读，避免与 approve/reject 竞态；改完再算一次与正式规则的相似度。
 */
export async function editPendingRule(id, text) {
  const next = normalizeRule(text);
  if (!next) return { ok: false, code: 'E_ARG', error: '规则内容不能为空。' };
  if (next.length > MAX_RULE_TEXT) {
    return { ok: false, code: 'E_ARG', error: `规则太长（${next.length} 字），上限 ${MAX_RULE_TEXT} 字。` };
  }
  const key = ruleKey(next);
  try {
    return await enqueue(() => withFileLock(pendingPath(), async () => {
      const list = readPendingStrict();
      const item = list.find((x) => x.id === String(id));
      if (!item) return { ok: false, code: 'E_NOT_FOUND', error: '没有这条待批规则（可能已被批准或丢弃）。' };
      if (list.some((x) => x.id !== item.id && ruleKey(x.text) === key)) {
        return { ok: false, code: 'E_DUPLICATE', error: '待批列表里已经有同样内容的另一条。' };
      }
      const existing = readCapped(codingPath(), Infinity) || '';
      const similar = similarRules(next, rulesOfLines(existing.split('\n')));
      item.text = next;
      await atomicWrite(pendingPath(), JSON.stringify(list, null, 2));
      return { ok: true, id: item.id, text: next, similar };
    }));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '修改待批规则失败：' + (e && e.message ? e.message : e) };
  }
}

export async function rejectRules(ids) {
  const wanted = new Set((ids || []).map((x) => String(x).trim()).filter(Boolean));
  if (!wanted.size) return { ok: false, code: 'E_ARG', error: '要给 reject 的规则 id。' };
  try {
    return await enqueue(() => withFileLock(pendingPath(), async () => {
      const cur = readPendingStrict();
      const kept = cur.filter((x) => !wanted.has(x.id));
      const removed = cur.length - kept.length;
      if (!removed) return { ok: false, code: 'E_NOT_FOUND', error: '没有匹配的待批规则 id。' };
      await atomicWrite(pendingPath(), JSON.stringify(kept, null, 2));
      return { ok: true, removed };
    }));
  } catch (e) {
    return { ok: false, code: 'E_IO', error: '写入待批规则失败：' + (e && e.message ? e.message : e) };
  }
}

// ---------- 注册 ----------
/**
 * @param {object} ctx 插件上下文
 * @param {{enabled?: boolean, budget?: number}} [options]
 */
export function registerCodingRules(ctx, options = {}) {
  if (options.enabled === false) return null;
  const budget = Number.isFinite(options.budget) ? Math.max(400, Math.min(8000, options.budget)) : DEFAULT_BUDGET;

  const section = ctx.systemPrompt.section({
    name: 'dsh-soul-memory:coding',
    order: 61,
    // 规则文件是用户内容，可能含 {{...}}；关闭插值，按纯文本注入。
    interpolate: false,
    text: ({ agent } = {}) => {
      try {
        const cwd = agent?.session?.header?.cwd || null;
        return collectRules(cwd, { budget }).text;
      } catch {
        return '';
      }
    },
  });

  const outputText = { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] };

  ctx.tools.register({
    name: 'coding_rules',
    description: withNotes('编码规范固定记忆。show=看当前会注入的规则（全局+项目）；list=看全局 CODING.md 原文；add=追加一条全局规则并立即生效（只在用户当场明确要求时用；可选 why/pitfall 记「为什么为真」和「陷阱」）；propose=提议一条规则进待批（你自己归纳、还没经用户确认的用这个，不注入）；pending=看待批列表；approve=按 id 批准写入（参数 ids）；reject=按 id 丢弃（参数 ids）；forget=删除一条全局规则（需完全匹配，连同子项一起删）；dupes=扫描全部规则里措辞相近的对（只提示，不自动合并）。add/propose/approve 会自动对比已有规则，给出重复或可合并的提示。' + GATE,
      '写入 <DSH home>/memory/CODING.md（项目层只读，来自 AGENTS.md/CLAUDE.md 等）；下一轮组装生效；不调用模型、不花钱。'),
    output: outputText,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'list', 'add', 'propose', 'pending', 'approve', 'reject', 'forget', 'dupes'], description: '操作' },
        text: { type: 'string', description: 'add / propose 时的规则内容（一句话，一条规则）' },
        ids: { type: 'array', items: { type: 'string' }, description: 'approve / reject 时的待批规则 id（来自 action=pending）' },
        why: { type: 'string', description: 'add / propose 可选：为什么这条为真（一句话）' },
        pitfall: { type: 'string', description: 'add / propose 可选：什么时候会踩坑（一句话）' },
      },
      required: ['action'],
    },
    async execute(args = {}, exec) {
      const action = args.action;
      if (action === 'add') {
        const res = await addRule(args.text, { why: args.why, pitfall: args.pitfall });
        if (!res.ok) return `未写入：${res.error}\n[err:${res.code || 'E_IO'}]`;
        const parts = [`已记入全局编码规范：${res.rule}`];
        const hint = similarHint(res.similar);
        if (hint) parts.push(hint);
        parts.push(usageLine(collectRules(null, { budget })));
        return parts.join('\n');
      }
      if (action === 'propose') {
        const res = await proposeRule(args.text, { why: args.why, pitfall: args.pitfall });
        if (!res.ok) return `未提议：${res.error}\n[err:${res.code || 'E_IO'}]`;
        const parts = [`已进入待批（id ${res.id}，共 ${res.count} 条）。用户批准后才会写进 CODING.md 并注入。`];
        const hint = similarHint(res.similar);
        if (hint) parts.push(hint);
        return parts.join('\n');
      }
      if (action === 'pending') {
        const res = await proposedRules();
        if (!res.ok) return `${res.error}\n[err:${res.code || 'E_IO'}]`;
        if (!res.list.length) return '没有待批规则。';
        const lines = [`待批 ${res.list.length} 条（approve 后才注入）：`];
        for (const item of res.list) {
          lines.push(`- [${item.id}] ${item.text}`);
          if (item.why) lines.push(`  - 为什么：${item.why}`);
          if (item.pitfall) lines.push(`  - 陷阱：${item.pitfall}`);
          if (item.source) lines.push(`  - 来源：${item.source}`);
        }
        return lines.join('\n');
      }
      if (action === 'approve') {
        const res = await approveRules(args.ids);
        if (!res.ok) return `未批准：${res.error}\n[err:${res.code || 'E_ARG'}]`;
        const parts = [`已批准 ${res.applied.length} 条，写入全局编码规范。`];
        if (res.failed && res.failed.length) parts.push(`失败 ${res.failed.length} 条：${res.failed.map((f) => `${f.id}（${f.error}）`).join('；')}`);
        const hint = similarHint(res.similar);
        if (hint) parts.push(hint);
        parts.push(usageLine(collectRules(null, { budget })));
        return parts.join('\n');
      }
      if (action === 'reject') {
        const res = await rejectRules(args.ids);
        return res.ok ? `已丢弃 ${res.removed} 条待批规则。` : `未丢弃：${res.error}\n[err:${res.code || 'E_ARG'}]`;
      }
      if (action === 'forget') {
        const res = await forgetRule(args.text);
        return res.ok ? `已删除 ${res.removed} 条规则。` : `未删除：${res.error}\n[err:${res.code || 'E_NOT_FOUND'}]`;
      }
      if (action === 'dupes') {
        const list = readGlobalRules();
        if (list.length < 2) return '规则不足两条，没有可比较的对。';
        const pairs = [];
        for (let i = 0; i < list.length; i++) {
          for (const hit of similarRules(list[i].rule, list.slice(i + 1), { threshold: 0.25 })) {
            pairs.push({ a: list[i].rule, b: hit.rule, score: hit.score });
          }
        }
        if (!pairs.length) return `共 ${list.length} 条规则，没有发现措辞相近的（阈值 0.4）。`;
        pairs.sort((x, y) => y.score - x.score);
        const lines = [`共 ${list.length} 条规则，发现 ${pairs.length} 对措辞相近（阈值 0.4，按相似度排序）：`];
        for (const p of pairs.slice(0, 6)) {
          lines.push(`- ${p.score}  A：${clip(p.a, 40)}`);
          lines.push(`      B：${clip(p.b, 40)}`);
        }
        lines.push('只是措辞像，不等于同一件事；确认要合并就写一条合并版，再用 action=forget 删掉多余的。');
        return lines.join('\n');
      }
      if (action === 'list') {
        const text = readCapped(codingPath());
        return text || '全局编码规范还是空的。可以 manual 编辑 ' + codingPath() + '，或用 action=add。';
      }
      if (action !== 'show') return '参数错误：action 必须是 show / list / add / propose / pending / approve / reject / forget / dupes。\n[err:E_ARG]';
      const cwd = exec?.agent?.session?.header?.cwd || null;
      const gathered = collectRules(cwd, { budget });
      if (!gathered.files.length) return '当前没有发现任何编码规范文件。可用 action=add 写一条全局规则，或在项目里放 AGENTS.md / CLAUDE.md / .cursorrules。';
      const lines = [
        `来源 ${gathered.files.length} 个，注入 ${gathered.used}/${gathered.budget} 字（${gathered.budget ? Math.round((gathered.used / gathered.budget) * 100) : 0}%）：`,
        ...gathered.files.map((f) => `- ${f.label}（${f.chars} 字）`),
        '',
        gathered.text,
      ];
      return lines.join('\n');
    },
  });

  return { section, budget };
}
