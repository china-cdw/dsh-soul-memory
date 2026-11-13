// 自动踩坑记录：捕获"工具报错 → 同会话内同类调用恢复"，把错误指纹与恢复做法存下来，
// 下次遇到同类报错时注入系统提示，避免重犯。纯本地、无模型调用。
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicWrite, createQueue, memoryHome, redactSecrets, sliceSafe, withFileLock } from './memory/util.js';
import { withNotes } from './tool-notes.js';

const DEFAULT_BUDGET = 600;
const MAX_ROWS = 400;
/** 宿主按 UTF-8 解码 cmd 的 GBK 输出时会留下 U+FFFD，原始字节在插件侧已不可得。 */
const GARBLED_RE = /\uFFFD/;
const GARBLED_LABEL = '<乱码>';

export const dshHome = memoryHome;

export function lessonsPath() {
  return join(memoryHome(), 'memory', 'LESSONS.jsonl');
}

const enqueue = createQueue();

/** 错误指纹：去掉路径、时间、纯数字等噪声后取首行，便于跨会话归并同类错误。 */
export function errorFingerprint(tool, text) {
  const raw = String(text ?? '');
  // 乱码输出无法按文本归并；按「工具 + 退出码」归并，至少同类失败能合并成一条。
  if (GARBLED_RE.test(raw) || raw.includes('输出编码无法识别')) {
    const code = exitCodeOf(raw);
    return `${tool}:<garbled-output>${code !== null ? ` exit ${code}` : ''}`;
  }
  const first = String(text ?? '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? '';
  const normalized = sliceSafe(first
    .replace(/[A-Za-z]:\\[^\s:]+/g, '<path>')
    .replace(/\/[^\s:'"]+/g, '<path>')
    .replace(/\b\d{3,}\b/g, '<n>')
    .replace(/\s+/g, ' '), 200);
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
  } catch (e) {
    // 文件不存在才是「空」；占用/权限错误必须抛给调用方，否则 clear/forget 会把读失败当成空清单整份清空。
    if (e && e.code === 'ENOENT') return [];
    throw e;
  }
}

async function appendRow(row) {
  return withFileLock(lessonsPath(), () => appendRowLocked(row));
}

async function appendRowLocked(row) {
  let rows = [];
  try {
    rows = (await readFile(lessonsPath(), 'utf8'))
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch (e) {
    // 只有「文件不存在」才是正常起点。其他读错误（占用/权限）必须放弃本次追加：
    // 把读失败当成空数组再整份写回，等于清空全部历史。
    if (!e || e.code !== 'ENOENT') throw e;
  }
  rows.push(row);
  const kept = rows.slice(-MAX_ROWS);
  await atomicWrite(lessonsPath(), kept.map((r) => JSON.stringify(r)).join('\n') + '\n');
}

function rowsToText(rows) {
  return rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : '');
}

/**
 * 整份重写：读和写都在同一条队列任务里完成。
 * 若在队列外先读，并发 appendRow 可能在这两步之间插入，导致刚记的坑被旧快照覆盖。
 */
async function rewriteRows(mutate) {
  // 整份重写必须和 appendRow 共用跨进程锁：只包进程内队列时，
  // 另一实例的 append 会落在 readRows 与 atomicWrite 之间被旧快照覆盖。
  return enqueue(() => withFileLock(lessonsPath(), async () => {
    const rows = await readRows();
    const next = await mutate(rows);
    if (next === null) return { ok: false, error: '没有找到匹配的记录。' };
    await atomicWrite(lessonsPath(), rowsToText(next));
    return { ok: true, removed: rows.length - next.length };
  }));
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
    lines.push(sliceSafe(line, 260));
  }
  const text = head + lines.join('\n');
  return text.length > budget ? sliceSafe(text, budget) + '\n…（已截断）' : text;
}

export async function listLessons() {
  return mergeRows(await readRows());
}

export async function forgetLesson(fingerprint) {
  const needle = String(fingerprint ?? '').trim();
  if (!needle) return { ok: false, error: '要删除的指纹不能为空。' };
  return rewriteRows((rows) => {
    const kept = rows.filter((row) => row.fp !== needle && !row.fp.includes(needle));
    return kept.length === rows.length ? null : kept;
  });
}

export async function clearLessons() {
  return rewriteRows((rows) => (rows.length ? [] : null)).then((res) =>
    res.ok ? res : { ok: true, removed: 0 });
}

/**
 * 注册自动踩坑记录。
 * @param {object} ctx 插件上下文
 * @param {{enabled?: boolean, budget?: number}} [options]
 */
const SHELL_TOOL = /^(ops_bash|bash|sh|shell|pwsh|powershell|cmd|exec|mcp__localexec__run|mcp__windows-mcp__PowerShell)$/i;
// exit 1 是这些命令的正常语义（有差异 / 无匹配），不算失败。
const BENIGN_EXIT_ONE = /^(diff|grep|rg|ag|find|test|cmp|comm|git\s+diff|git\s+grep)\b/i;

const ERROR_LOOK = /error|fail|cannot|can't|not found|no such|denied|exception|invalid|missing|fatal|refused|unable|unexpected|typeerror|syntaxerror|enoent|eacces|timeout|超时|失败|错误|无法|不存在/i;

/** 文本看起来是不是一条错误，避免把普通输出记成"坑"。 */
function looksLikeError(text) {
  return ERROR_LOOK.test(String(text ?? '').slice(0, 400));
}

/** 从文本里取退出码：支持 `[exit code: N]` 和 `EXIT_CODE N` / `EXIT_CODE=N`。取不到返回 null。 */
export function exitCodeOf(text) {
  const s = String(text ?? '');
  const m = /\[exit code:\s*(-?\d+)\]/i.exec(s) || /\bEXIT_CODE\b\s*[:=]?\s*(-?\d+)/i.exec(s);
  return m ? Number(m[1]) : null;
}

/** 工具结果是否算失败：优先结构化信号（isError / 退出码），文本只做无信号时兜底。 */
function failureOf(message, meta, text, call = {}) {
  if (message?.isError === true) return { text: text || '工具返回错误', structured: true };
  // 只有 shell 类工具才可能因正文里的退出码标记而失败；
  // read/grep 等工具的正文是用户文件内容，里面出现标记字符串不代表命令失败。
  if (!SHELL_TOOL.test(call.name || '')) return null;
  const args = call.args || '';
  const shell = meta?.opsShell ?? meta?.shell;
  const shellCode = Number(shell?.exitCode);
  const code = shell && Number.isFinite(shellCode) ? shellCode : exitCodeOf(text);
  if (code !== null) {
    if (code === 0) return null; // 退出码 0 明确成功，不能记成坑
    if (code === 1 && BENIGN_EXIT_ONE.test(args)) return null;
    // 只剩 `===` / `---` 这类分隔符的"报错"不构成教训，记下来只会污染注入。
    if (String(text ?? '').replace(/\s+/g, '').length < 4) return null;
    return { text, structured: true };
  }
  // 只看到标记、取不到数字：交给调用侧用文本兜底判断，避免直接漏记。
  if (/\bEXIT_CODE\b/i.test(text)) return { text, structured: false };
  return null;
}

/** 把 U+FFFD 乱码折叠成可读标注；宿主解码前的原始字节已不可得。 */
function garbledLabel(text) {
  const raw = String(text ?? '');
  if (!GARBLED_RE.test(raw)) return raw;
  const code = exitCodeOf(raw);
  const bad = String.fromCharCode(0xfffd);
  const nl = String.fromCharCode(10);
  let cleaned = '';
  for (const ch of raw) {
    if (ch === bad) {
      if (!cleaned.endsWith(GARBLED_LABEL)) cleaned += GARBLED_LABEL;
    } else {
      cleaned += ch;
    }
  }
  cleaned = cleaned.split(nl).map((line) => line.trim()).filter(Boolean).join(' | ');
  return `（命令输出编码无法识别${code !== null ? `，退出码 ${code}` : ''}）${cleaned || '无可用报错文本'}`;
}

/** 去掉 harness 包装行，让错误指纹稳定；退出码行保留（它是判定依据，也能稳定指纹）。 */
function cleanErrorText(text) {
  const kept = String(text ?? "")
    .split(/\r?\n/)
    .filter((line) => !/^\s*\[(cwd:|stdout|stderr)/i.test(line));
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
  const MAX_SESSIONS = 64;

  const stateOf = (sid) => {
    let state = sessions.get(sid);
    if (state) {
      // 命中即移到队尾，淘汰时丢最久没活动的会话。
      sessions.delete(sid);
      sessions.set(sid, state);
      return state;
    }
    state = { calls: new Map(), pending: new Map() };
    sessions.set(sid, state);
    while (sessions.size > MAX_SESSIONS) {
      const oldest = sessions.keys().next().value;
      if (oldest === undefined) break;
      sessions.delete(oldest);
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
    // 记录正文来自工具报错，可能含 {{...}}；按纯文本注入，不做模板插值。
    interpolate: false,
    text: () => cached,
  });

  ctx.tools.register({
    name: 'lessons',
    description: withNotes('自动踩坑记录：list=看记录（同类错误已合并计数）；forget=按错误文本或指纹删除一条；clear=清空。记录由插件在"工具报错后同会话恢复"时自动写入。',
      '写入 <DSH home>/memory/LESSONS.jsonl（上限 ' + MAX_ROWS + ' 条，超出按旧→新淘汰）；不调用模型、不花钱。'),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: { type: 'string', enum: ['list', 'forget', 'clear'] },
        text: { type: 'string', description: 'forget 时的错误文本片段或指纹' },
        limit: { type: 'number', description: 'list 时最多显示多少类（默认 50，上限 200）' },
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
        if (!String(args.text ?? '').trim()) return '参数错误：forget 需要 text（错误文本片段或指纹）。\n[err:E_ARG]';
        const res = await forgetLesson(String(args.text).trim());
        refresh();
        return res.ok ? `已删除 ${res.removed} 条记录。` : `未删除：${res.error}\n[err:E_NOT_FOUND]`;
      }
      const rows = await readRows();
      const merged = mergeRows(rows);
      if (!merged.length) return `还没有记录。文件：${lessonsPath()}`;
      const limit = typeof args.limit === 'number' && args.limit > 0 ? Math.min(Math.floor(args.limit), 200) : 50;
      const shown = merged.slice(0, limit);
      const lines = shown.map((row) => {
        const times = row.count > 1 ? ` ×${row.count}` : '';
        const ok = row.ok ? `；生效做法：${row.ok}` : '';
        return `- [${row.tool}]${times} ${row.error}${ok}\n  fp: ${row.fp}`;
      });
      const more = merged.length > shown.length ? `\n…（还有 ${merged.length - shown.length} 类未显示，可加 limit 参数）` : '';
      return `共 ${merged.length} 类，${rows.length} 条原始记录（${lessonsPath()}）：\n${lines.join('\n')}${more}`;
    },
  });

  const UNCAPTURED = new Set(['lessons', 'coding_rules', 'memory_write', 'memory_core', 'memory_search', 'memory_read', 'memory_list', 'memory_delete', 'memory_brief', 'persona', 'soul_recall', 'soul_expand', 'evolve_status', 'evolve_diagnose', 'evolve_request', 'evolve_tree', 'edit', 'write', 'ops_edit_file', 'ops_write_file', 'ops_replace']);
  // 一条失败只在「同一个回合、同一类命令」内等待恢复，跨回合不算因果关系。
  const PENDING_TTL_MS = 10 * 60 * 1000;
  const MAX_PENDING = 8;

  function pendingList(state, name) {
    let list = state.pending.get(name);
    if (!Array.isArray(list)) { list = []; state.pending.set(name, list); }
    return list;
  }

  /** 非 shell 工具没有命令行：用参数里同一语义键（文件/查询）判断是否同一次操作。 */
  function relatedStructured(a, b) {
    if (!a || !b) return false;
    try {
      const x = JSON.parse(a);
      const y = JSON.parse(b);
      if (!x || !y) return false;
      for (const k of ['path', 'file', 'query', 'pattern', 'url']) {
        if (typeof x[k] === 'string' && x[k] === y[k]) return true;
      }
      return false;
    } catch { return false; }
  }

  /** 同一类命令：完全相同，或互为前缀，或首词相同（npm test / npm test -- --x）。 */
  function relatedCommand(a, b) {
    const x = String(a || '').trim();
    const y = String(b || '').trim();
    if (!x || !y) return true; // 拿不到命令就不拿命令当反证
    if (x === y || x.startsWith(y) || y.startsWith(x)) return true;
    return x.split(/\s+/)[0].toLowerCase() === y.split(/\s+/)[0].toLowerCase();
  }

  ctx.on('session/event', (session, event) => {
    try {
      const sid = String(session?.id ?? session?.header?.id ?? '');
      if (!sid || !event) return;
      const state = stateOf(sid);
      // 回合结束：没等到的恢复机会作废，避免把下一轮的成功算到上一轮的失败上。
      if (event.type === 'turn/end' || event.type === 'session/end') {
        state.pending.clear();
        state.calls.clear();
        return;
      }
      if (event.type !== 'tool/call' && event.type !== 'tool/result') return;
      const data = event.data ?? {};
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
      if (!call) return;
      state.calls.delete(callId);
      if (UNCAPTURED.has(call.name)) return;
      const failure = failureOf(data.message, data.meta, stringContent(data.message?.content), call);
      const now = Date.now();
      if (failure !== null) {
        const text = redact(garbledLabel(cleanErrorText(failure.text)));
        if (!text) return;
        // 只有在拿不到结构化信号时，才用正文关键词兜底，避免普通输出被记成"坑"。
        if (!failure.structured && !looksLikeError(text)) return;
        const first = text.split(/\r?\n/).find((line) => line.trim()) ?? text;
        const list = pendingList(state, call.name).filter((p) => now - p.at < PENDING_TTL_MS);
        list.push({
          fp: errorFingerprint(call.name, text),
          error: first.slice(0, 200),
          args: call.args || '',
          structured: Boolean(failure.structured),
          at: now,
          cwd: String(session?.header?.cwd || ''),
        });
        while (list.length > MAX_PENDING) list.shift();
        state.pending.set(call.name, list);
        return;
      }
      const list = pendingList(state, call.name);
      if (!list.length) return;
      // 只取最近一次仍然有效、且命令相关的失败；同命令重跑成功不算纠正。
      const cwd = String(session?.header?.cwd || '');
      let picked = -1;
      for (let i = list.length - 1; i >= 0; i--) {
        const p = list[i];
        if (now - p.at >= PENDING_TTL_MS) continue;
        if (p.cwd && cwd && p.cwd !== cwd) continue;
        // 结构化错误（isError）来自宿主，信号可靠；非 shell 工具没有"命令"可比，
        // 只要还是同一个工具、同一个目录，就允许把后续成功当作恢复。
        const related = relatedCommand(p.args, call.args) ||
          (p.structured && !SHELL_TOOL.test(call.name) && relatedStructured(p.args, call.args));
        if (!related) continue;
        // 同一命令重跑成功不算纠正；非 shell 工具没有"命令"，参数相同正是"原操作重试成功"。
        if (SHELL_TOOL.test(call.name) && p.args && call.args && p.args === call.args && p.args.length > 2 && p.args !== '{}') continue;
        picked = i;
        break;
      }
      if (picked < 0) return;
      const pending = list[picked];
      list.splice(picked, 1);
      if (!list.length) state.pending.delete(call.name);
      const ok = call.args ? call.args : '';
      enqueue(() => appendRow({ fp: pending.fp, tool: call.name, error: pending.error, ok, at: now, session: sid }))
        .then(refresh)
        .catch((e) => console.error('dsh-x-memory: 记录踩坑失败：' + (e?.message ?? e)));
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
