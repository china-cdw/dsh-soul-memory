// dsh-x-memory — 编码规范固定记忆层
//
// 目标：让"怎么写代码"这类规则跨会话固定下来，而不是每次靠人重复。
// 两个来源，一起注入（有字节预算，超了就截断并注明）：
//   1) 全局：<dshHome>/memory/CODING.md —— 你认可的通用编码/工程习惯，任何项目都生效；
//   2) 项目：当前工作目录下的 AGENTS.md / CLAUDE.md / .cursorrules /
//      .cursor/rules/*.mdc / .github/copilot-instructions.md / .dsh/rules.md / CODING.md。
// 工具 coding_rules 负责写全局层（add / forget / list / show），写入即持久，下一轮生效。
//
// 设计参考：AGENTS.md 约定（https://agents.md/）、Cursor rules、以及 dsh-meow-memory 的
// rules 层——但这里不做检索/嵌入，只做"小而常驻"，避免和 MEMORY.md 抢预算。
import { readFileSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWrite, createQueue, memoryHome } from './memory/util.js';

const DEFAULT_BUDGET = 2000;
const FILE_CHAR_CAP = 6000;
const MAX_RULE_TEXT = 2000;
const MAX_DIR_FILES = 20;

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
  '> dsh-x-memory 的固定记忆层：以下规则注入每个会话的系统提示（有预算上限），跨项目生效。',
  '> 用 coding_rules action=add 追加；action=list 查看；action=forget 删除；action=show 看当前实际注入内容。',
  '',
  '## 规则',
  '',
].join('\n');

export function codingPath() {
  return join(memoryHome(), 'memory', 'CODING.md');
}

// ---------- 读文件 ----------
function readCapped(path, cap = FILE_CHAR_CAP) {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size === 0) return null;
    let text = readFileSync(path, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n/g, '\n').trim();
    if (!text) return null;
    // cap=Infinity 表示「写回用的完整读取」：截断只用于注入与展示，绝不能拿截断文本回写。
    if (Number.isFinite(cap) && text.length > cap) text = text.slice(0, cap) + '\n…（文件过长，已截断）';
    return text;
  } catch {
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
    '# 编码规范（dsh-x-memory）',
    '',
    '以下是本机与当前项目的编码约定。写代码、改文件时遵守；与用户当轮明确指令冲突时以用户为准。',
    '用户纠正你的写法后，用 coding_rules action=add 记到全局层，下次会话仍然生效。',
    '',
  ];
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
        const cut = chunk.body.slice(0, avail);
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

  if (!lines.length) return { text: '', files, used: 0, budget, truncated: false };
  const text = head + lines.join('\n\n');
  return { text, files, used: text.length, budget, truncated };
}

// ---------- 写全局层 ----------
const enqueue = createQueue();

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

export async function addRule(text) {
  const rule = normalizeRule(text);
  if (!rule) return { ok: false, error: '规则内容不能为空。' };
  if (rule.length > MAX_RULE_TEXT) return { ok: false, error: `规则太长（${rule.length} 字），上限 ${MAX_RULE_TEXT} 字。` };
  return enqueue(async () => {
    const path = codingPath();
    // 写回必须基于完整文件：readCapped 的默认 cap 只用于注入，不能用来改文件。
    const existing = readCapped(path, Infinity) ?? TEMPLATE;
    const lines = existing.split('\n');
    if (lines.some((line) => ruleKey(line.replace(/^\s*-\s*/, '')) === ruleKey(rule))) {
      return { ok: false, error: '已有相同规则，未重复写入。' };
    }
    const idx = lines.findIndex((line) => line.trim() === '## 规则');
    if (idx >= 0) {
      let at = idx + 1;
      while (at < lines.length && lines[at].trim() === '') at++;
      lines.splice(at, 0, `- ${rule}`);
    } else {
      lines.push('', '## 规则', '', `- ${rule}`);
    }
    await atomicWrite(path, lines.join('\n').replace(/\n{3,}/g, '\n\n'));
    return { ok: true, rule };
  });
}

export async function forgetRule(text) {
  const rule = normalizeRule(text);
  if (!rule) return { ok: false, error: '要删除的规则内容不能为空。' };
  return enqueue(async () => {
    const path = codingPath();
    const existing = readCapped(path, Infinity);
    if (!existing) return { ok: false, error: '全局编码规范还是空的。' };
    const lines = existing.split('\n');
    const kept = lines.filter((line) => {
      const m = line.match(/^\s*-\s*(.*)$/);
      if (!m) return true;
      return ruleKey(m[1]) !== ruleKey(rule);
    });
    const removed = lines.length - kept.length;
    if (!removed) return { ok: false, error: '没有找到完全匹配的规则；先 action=list 看一眼。' };
    await atomicWrite(path, kept.join('\n'));
    return { ok: true, removed };
  });
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
    name: 'dsh-x-memory:coding',
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
    description: '编码规范固定记忆。show=看当前会注入的规则（全局+项目）；list=看全局 CODING.md 原文；add=追加一条全局规则（跨会话生效，用户纠正你的写法后用它记住）；forget=删除一条全局规则（需完全匹配）。',
    output: outputText,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['show', 'list', 'add', 'forget'], description: '操作' },
        text: { type: 'string', description: 'add / forget 时的规则内容（一句话，一条规则）' },
      },
      required: ['action'],
    },
    async execute(args = {}, exec) {
      const action = args.action;
      if (action === 'add') {
        const res = await addRule(args.text);
        return res.ok ? `已记入全局编码规范：${res.rule}` : `未写入：${res.error}`;
      }
      if (action === 'forget') {
        const res = await forgetRule(args.text);
        return res.ok ? `已删除 ${res.removed} 条规则。` : `未删除：${res.error}`;
      }
      if (action === 'list') {
        const text = readCapped(codingPath());
        return text || '全局编码规范还是空的。可以 manual 编辑 ' + codingPath() + '，或用 action=add。';
      }
      if (action !== 'show') return '参数错误：action 必须是 show / list / add / forget。';
      const cwd = exec?.agent?.session?.header?.cwd || null;
      const gathered = collectRules(cwd, { budget });
      if (!gathered.files.length) return '当前没有发现任何编码规范文件。可用 action=add 写一条全局规则，或在项目里放 AGENTS.md / CLAUDE.md / .cursorrules。';
      const lines = [
        `来源 ${gathered.files.length} 个，注入 ${gathered.used}/${gathered.budget} 字：`,
        ...gathered.files.map((f) => `- ${f.label}（${f.chars} 字）`),
        '',
        gathered.text,
      ];
      return lines.join('\n');
    },
  });

  return { section, budget };
}
