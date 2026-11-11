// 自动踩坑记录：捕获"工具报错 → 同会话内同类调用恢复"，把错误指纹与恢复做法存下来，
// 下次遇到同类报错时注入系统提示，避免重犯。纯本地、无模型调用。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, createQueue, memoryHome, redactSecrets } from './memory/util.js';

const DEFAULT_BUDGET = 600;
const MAX_ROWS = 400;

export const dshHome = memoryHome;

export function lessonsPath() {
  return join(memoryHome(), 'memory', 'LESSONS.jsonl');
}

const enqueue = createQueue();

/** 错误指纹：去掉路径、时间、纯数字等噪声后取首行，便于跨会话归并同类错误。 */
export function errorFingerprint(tool, text) {
  const first = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const normalized = first
    .replace(/[A-Za-z]:\\[^\s:]+/g, '<path>')
    .replace(/\/[^\s:'"]+/g, '<path>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  return `${tool}:${normalized}`;
}

function redact(text) {
  return redactSecrets(text, 600);
}

async function readRows() {
  try {
    const raw = await readFile(lessonsPath(), 'utf8');
    const rows = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row.fp === 'string') rows.push(row);
      } catch {
        /* 坏行跳过，不让记录毁掉整份清单 */
      }
    }
    return rows;
  } catch {
    return [];
  }
}

async function appendRow(row) {
  let rows = [];
  try {
    rows = (await readFile(lessonsPath(), 'utf8'))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    /* 文件不存在是正常起点 */
  }
  rows.push(row);
  const kept = rows.slice(-MAX_ROWS);
  await atomicWrite(lessonsPath(), kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

/**
 * 合并同类记录：同一指纹累加次数，保留最近的恢复做法。
 * @returns {Array<{fp:string,tool:string,error:string,ok:string,count:number,at:number}>}
 */
export function mergeRows(rows) {
  const byFp = new Map();
  for (const row of rows) {
    const prev = byFp.get(row.fp);
    if (!prev) {
      byFp.set(row.fp, { fp: row.fp, tool: row.tool ?? '', error: row.error ?? '', ok: row.ok ?? '', count: row.count ?? 1, at: row.at ?? 0 });
      continue;
    }
    prev.count += row.count ?? 1;
    if ((row.at ?? 0) >= prev.at) {
      prev.at = row.at ?? prev.at;
      if (row.ok) prev.ok = row.ok;
    }
    if (!prev.error && row.error) prev.error = row.error;
  }
  return [...byFp.values()].sort((a, b) => b.count - a.count || b.at - a.at);
}

/** 注入文本：只给"重复过 / 最近"的少量坑位，明确标为自动记录。 */
export function buildLessonsText(rows, { budget = DEFAULT_BUDGET, limit = 6 } = {}) {
  const merged = mergeRows(rows).slice(0, limit);
  if (!merged.length) return '';
  const head = [
    '# 踩过的坑（dsh-x-memory 自动记录）',
    '',
    '同一次会话里，某条命令报错后同类调用恢复，就会记在这里。只是线索，不一定精确；确认可长期复用的，可以用 coding_rules action=add 固化成规则。',
    '',
  ].join('\n');
  const lines = [];
  for (const row of merged) {
    const when = row.at ? new Date(row.at).toISOString().slice(0, 10) : '';
    const times = row.count > 1 ? `（出现过 ${row.count} 次）` : '';
    const ok = row.ok ? `；生效做法：${row.ok}` : '';
    const line = `- [${row.tool}] ${row.error}${ok}${times}${when ? ` — ${when}` : ''}`;
    lines.push(line.slice(0, 260));
  }
  const text = head + lines.join('\n');
  return text.length > budget ? text.slice(0, budget) + '\n…（已截断）' : text;
}

export async function listLessons() {
  return mergeRows(await readRows());
}

export async function forgetLesson(fingerprint) {
  const rows = await readRows();
  const kept = rows.filter((row) => row.fp !== fingerprint && !row.fp.includes(fingerprint));
  if (kept.length === rows.length) return { ok: false, error: '没有找到匹配的记录。' };
  await atomicWrite(lessonsPath(), kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
  return { ok: true, removed: rows.length - kept.length };
}

export async function clearLessons() {
  const rows = await readRows();
  if (!rows.length) return { ok: true, removed: 0 };
  await atomicWrite(lessonsPath(), '');
  return { ok: true, removed: rows.length };
}

/**
 * 注册自动踩坑记录。
 * @param {object} ctx 插件上下文
 * @param {{enabled?: boolean, budget?: number}} [options]
 */
const SHELL_TOOL = /^(ops_bash|bash|sh|shell|pwsh|powershell|cmd|exec)$/i;
// exit 1 是这些命令的正常语义（有差异 / 无匹配），不算失败。
const BENIGN_EXIT_ONE = /^(diff|grep|rg|ag|find|test|cmp|comm|git\s+diff|git\s+grep)\b/i;

const ERROR_LOOK = /error|fail|cannot|can't|not found|no such|denied|exception|invalid|missing|fatal|refused|unable|unexpected|typeerror|syntaxerror|enoent|eacces|timeout|超时|失败|错误|无法|不存在/i;

/** 文本看起来是不是一条错误，避免把普通输出记成"坑"。 */
function looksLikeError(text) {
  return ERROR_LOOK.test(String(text ?? '').slice(0, 400));
}

/** 工具结果是否算失败：只认结构化信号，不拿文件内容当证据。 */
function failureOf(message, meta, text, call = {}) {
  if (message?.isError === true) return text || '工具返回错误';
  // 只有 shell 类工具才可能因正文里的退出码标记而失败；
  // read/grep 等工具的正文是用户文件内容，里面出现标记字符串不代表命令失败。
  if (!SHELL_TOOL.test(call.name || '')) return null;
  const args = call.args || '';
  const shell = meta?.opsShell ?? meta?.shell;
  const code = Number(shell?.exitCode);
  if (shell && Number.isFinite(code) && code !== 0) {
    if (code === 1 && BENIGN_EXIT_ONE.test(args)) return null;
    return text;
  }
  const exit = /\[exit code:\s*(-?\d+)\]/i.exec(text);
  if (exit && Number(exit[1]) !== 0) {
    if (Number(exit[1]) === 1 && BENIGN_EXIT_ONE.test(args)) return null;
    return text;
  }
  if (/\[EXIT_CODE\b/i.test(text)) return text;
  return null;
}

/** 去掉 harness 包装行，让错误指纹稳定。 */
function cleanErrorText(text) {
  const kept = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[(cwd:|stdout|stderr|EXIT_CODE|exit code:)/i.test(line));
  return kept.join("\n").trim() || String(text ?? "").trim();
}

/** 记录“成功做法”：bash 类工具取 command，否则截断原文。 */
function compactArgs(raw) {
  if (raw == null) return "";
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.command === "string") return parsed.command.slice(0, 160);
    } catch { /* 非 JSON 原文 */ }
    return raw.slice(0, 200);
  }
  if (typeof raw === "object") {
    if (typeof raw.command === "string") return raw.command.slice(0, 160);
    try { return JSON.stringify(raw).slice(0, 200); } catch { return ""; }
  }
  return "";
}

export function registerLessons(ctx, options = {}) {
  if (options.enabled === false) return null;
  const budget = Number.isFinite(options.budget) ? Math.max(200, Math.min(4000, options.budget)) : DEFAULT_BUDGET;
  const sessions = new Map();

  const stateOf = (sid) => {
    let state = sessions.get(sid);
    if (!state) {
      state = { calls: new Map(), pending: new Map() };
      sessions.set(sid, state);
    }
    return state;
  };

  // 注入文本来自文件，用异步刷新；section 的 text 是同步的，读最近一次缓存。
  let cached = '';
  const refresh = () => {
    readRows()
      .then((rows) => { cached = buildLessonsText(rows, { budget }); })
      .catch(() => {});
  };
  refresh();
  const section = ctx.systemPrompt.section({
    name: 'dsh-x-memory:lessons',
    order: 62,
    text: () => cached,
  });

  ctx.tools.register({
    name: 'lessons',
    description: '自动踩坑记录：list=看记录（同类错误已合并计数）；forget=按错误文本或指纹删除一条；clear=清空。记录由插件在"工具报错后同会话恢复"时自动写入。',
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'forget', 'clear'] },
        text: { type: 'string', description: 'forget 时的错误文本片段或指纹' },
      },
      required: ['action'],
    },
    async execute(args = {}) {
      if (args.action === 'clear') {
        const res = await clearLessons();
        refresh();
        return `已清空 ${res.removed} 条踩坑记录。`;
      }
      if (args.action === 'forget') {
        if (!String(args.text ?? '').trim()) return '参数错误：forget 需要 text（错误文本片段或指纹）。';
        const res = await forgetLesson(String(args.text).trim());
        refresh();
        return res.ok ? `已删除 ${res.removed} 条记录。` : `未删除：${res.error}`;
      }
      const rows = await readRows();
      const merged = mergeRows(rows);
      if (!merged.length) return `还没有记录。文件：${lessonsPath()}`;
      const lines = merged.map((row) => {
        const times = row.count > 1 ? ` ×${row.count}` : '';
        const ok = row.ok ? `；生效做法：${row.ok}` : '';
        return `- [${row.tool}]${times} ${row.error}${ok}\n  fp: ${row.fp}`;
      });
      return `共 ${merged.length} 类，${rows.length} 条原始记录（${lessonsPath()}）：\n${lines.join('\n')}`;
    },
  });

  const UNCAPTURED = new Set(['lessons', 'coding_rules', 'memory_write', 'memory_core', 'memory_search', 'memory_read', 'memory_list', 'memory_delete', 'memory_brief', 'persona', 'edit', 'write', 'ops_edit_file', 'ops_write_file', 'ops_replace']);

  ctx.on('session/event', (session, event) => {
    try {
      const sid = String(session?.id ?? session?.header?.id ?? '');
      if (!sid || !event || (event.type !== 'tool/call' && event.type !== 'tool/result')) return;
      const data = event.data ?? {};
      const state = stateOf(sid);
      if (event.type === 'tool/call') {
        const callId = data.callId ?? data.message?.toolCallId;
        const name = data.name ?? data.message?.name;
        if (!callId || !name) return;
        const args = data.arguments ?? data.args ?? data.message?.arguments ?? null;
        state.calls.set(String(callId), { name: String(name), args: compactArgs(args) });
        return;
      }
      const callId = String(data.message?.toolCallId ?? data.callId ?? '');
      const call = state.calls.get(callId);
      if (!call || UNCAPTURED.has(call.name)) return;
      state.calls.delete(callId);
      const failure = failureOf(data.message, data.meta, stringContent(data.message?.content), call);
      if (failure !== null) {
        const text = redact(cleanErrorText(failure));
        if (!text) return;
        // 非 isError 的失败（靠退出码/标记判出来的）还要求正文像错误，
        // 否则普通命令输出也会被记成"坑"。
        if (data.message?.isError !== true && !looksLikeError(text)) return;
        const first = text.split(/\r?\n/).find((line) => line.trim()) ?? text;
        state.pending.set(call.name, { fp: errorFingerprint(call.name, text), error: first.slice(0, 200), args: call.args || '', at: Date.now() });
        return;
      }
      const pending = state.pending.get(call.name);
      if (!pending) return;
      state.pending.delete(call.name);
      // 同一条命令重跑成功，不构成“纠正”，不算学到做法（空参数/占位参数除外）。
      if (pending.args && call.args && pending.args === call.args && pending.args.length > 2 && pending.args !== '{}') return;
      const ok = call.args ? call.args : '';
      enqueue(() => appendRow({ fp: pending.fp, tool: call.name, error: pending.error, ok, at: Date.now(), session: sid }))
        .then(refresh)
        .catch(() => {});
    } catch {
      /* 自动记录不能影响主流程 */
    }
  });

  return { section, budget };
}

function stringContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}
