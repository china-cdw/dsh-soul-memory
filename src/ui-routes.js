// dsh-soul-memory — 灵魂记忆设置页的 Host 接口
//
// 设置页是浏览器里的 React 组件，不能直接读文件；它通过同源 fetch 调这里。
// 三条路由（前缀 /dsh-soul-memory）：
//   GET  /dsh-soul-memory/state   一次取全：界面设置、待批、规则、风格、分级
//   POST /dsh-soul-memory/ui      改形态 / 称呼
//   POST /dsh-soul-memory/pending 批准 / 拒绝待批规则
// 风格（PERSONA.md）有自己的 /dsh-soul-memory/persona 路由，这里不重复实现。
//
// 安全模型与 persona 路由保持一致：只接受本机回环 Host、同源 Origin、
// 自定义请求头 x-dsh-soul-memory: 1，POST 必须是 application/json。
// 三条各自独立检查——少一条都会留下 CSRF / DNS rebinding 的口子。
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { codingPath, proposedRules, approveRules, rejectRules, editPendingRule, editRule, forgetRule, readGlobalRuleBlocks, collectRules } from './coding.js';
import { readUiSettings, writeUiSettings, validateUiPatch, MAX_NICKNAME, MIN_RULES_BUDGET, MAX_RULES_BUDGET } from './ui-settings.js';
import { readPersona, listPresets, MAX_CUSTOM_TEXT } from './persona.js';
import { GC_DEFAULTS, tierCounts, collectionCandidates } from './tiering.js';
import { memoryPath } from './memory/util.js';
import { readDreamingState, writeDreamingState, withDreamingRunLock } from './dreaming.js';

const PREFIX = '/dsh-soul-memory/';
const BODY_LIMIT = 64 * 1024; // 待批批量操作与规则预览；与 persona 的 16KB 不同是有意的（批量批准）。
const MAX_PENDING_IDS = 40; // 待批上限 20，留一倍余量，防止构造超长 ids。
const GUARD_HEADER = 'x-dsh-soul-memory';
const TOKEN_HEADER = 'x-dsh-soul-memory-token';
/**
 * 写操作令牌：写接口要求带上它。
 * GET /state 会返回它，所以它挡不住「先读再写」的本机脚本，只挡不知道要两步的顺手调用；
 * 真正的边界仍是回环 Host + 同源 Origin + 自定义头这三道。
 *
 * It is persisted rather than generated per module load: a hot reload used to mint a new
 * token while the open page still held the old one, and every write the user then made was
 * rejected with 403 until a manual refresh. Reading it back from the memory dir keeps the
 * page working across reloads; the file is inside the user's own home, not world-readable.
 */
function loadWriteToken() {
  const file = join(memoryPath(), '.ui-token');
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{32}$/.test(existing)) return existing;
  } catch { /* first run: mint one below */ }
  const token = randomBytes(16).toString('hex');
  try {
    mkdirSync(memoryPath(), { recursive: true });
    writeFileSync(file, token, 'utf8');
  } catch { /* read-only home: the in-memory token still works for this process */ }
  return token;
}
const WRITE_TOKEN = loadWriteToken();

function sendJson(res, code, payload) {
  try {
    const body = JSON.stringify(payload);
    res.statusCode = code;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    // 记忆与设置都是个人数据，禁止任何缓存。
    res.setHeader('cache-control', 'no-store');
    res.end(body);
  } catch {
    /* 响应已发出时忽略 */
  }
}

/** 只允许本机回环 Host：DNS rebinding 下 Origin 与 Host 都是攻击者域名，必须单独挡。 */
function isLoopbackHost(req) {
  const host = String(req.headers.host || '').toLowerCase();
  if (!host) return true;
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
  return ['localhost', '127.0.0.1', '[::1]', '::1'].includes(name);
}

/**
 * 统一入口守卫。通过返回 true；否则已写响应并返回 false。
 * @param {boolean} needsJson POST 时要求 application/json。
 */
function guard(req, res, needsJson) {
  if (!isLoopbackHost(req)) {
    sendJson(res, 403, { error: '仅允许本机页面访问' });
    return false;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    sendJson(res, 405, { error: '仅支持 GET / POST' });
    return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(origin).host === req.headers.host;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      sendJson(res, 403, { error: '跨源请求被拒绝' });
      return false;
    }
  }
  // 跨站表单/链接无法带自定义头，且会触发 CORS 预检。
  if (String(req.headers[GUARD_HEADER] || '') !== '1') {
    sendJson(res, 403, { error: '缺少 ' + GUARD_HEADER + ': 1 请求头' });
    return false;
  }
  if (needsJson) {
    const ctype = String(req.headers['content-type'] || '').toLowerCase();
    if (!ctype.startsWith('application/json')) {
      sendJson(res, 415, { error: 'Content-Type 必须是 application/json' });
      return false;
    }
  }
  return true;
}

/** 写接口额外要求令牌；失败时已写响应并返回 false。 */
function requireToken(req, res) {
  if (String(req.headers[TOKEN_HEADER] || '') !== WRITE_TOKEN) {
    sendJson(res, 403, { error: '缺少或错误的写操作令牌，先刷新一次页面' });
    return false;
  }
  return true;
}

/** 读 JSON 请求体；超限返回 tooLarge，坏 JSON 返回 null。 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    req.on('data', (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > BODY_LIMIT) {
        finish({ tooLarge: true });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text.trim()) return finish({ body: {} });
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return finish({ body: null });
        }
        finish({ body: parsed });
      } catch {
        finish({ body: null });
      }
    });
    req.on('error', () => finish({ error: true }));
  });
}

/** 全局分级快照（跨项目）。设置页没有 session，不能按 scope 取；口径写在 allProjects 里。 */
function tierOverview(store) {
  const empty = { high: 0, medium: 0, low: 0, collectable: 0, minAgeDays: GC_DEFAULTS.minAgeDays, allProjects: true };
  if (!store || !store.db) return empty;
  try {
    const rows = store.db
      .prepare("SELECT kind, pin, hits, created FROM node WHERE state='active' AND valid_to IS NULL")
      .all();
    const now = Date.now();
    const nodes = rows.map((row) => ({
      kind: row.kind,
      pin: row.pin === 1,
      hits: row.hits,
      ageDays: (now - Number(row.created || 0)) / 86400000,
    }));
    // 复用 tiering.js 的判据：统计口径只有一个来源，页面上的数字不会和 memory_tier 漂移。
    const counts = tierCounts(nodes);
    return {
      ...counts,
      collectable: collectionCandidates(nodes, GC_DEFAULTS).length,
      minAgeDays: GC_DEFAULTS.minAgeDays,
      allProjects: true,
    };
  } catch (error) {
    // 不要把「统计失败」伪装成「一条记忆都没有」。
    return { ...empty, error: (error && error.message) || String(error) };
  }
}

/** 读 CODING.md；ENOENT 视为空文件，其他错误单独报，避免把「读失败」显示成「没有规则」。 */
function readRulesText() {
  try {
    return { text: readFileSync(codingPath(), 'utf8'), error: null };
  } catch (e) {
    if (e && e.code === 'ENOENT') return { text: '', error: null };
    return { text: '', error: (e && e.message) || String(e) };
  }
}

/** 规则用量（与 coding_rules show 同一口径）。 */
function rulesUsageOf(budget = null) {
  try {
    const g = collectRules(null, budget == null ? {} : { budget });
    const pct = g.budget ? Math.round((g.used / g.budget) * 100) : 0;
    return { used: g.used, budget: g.budget, pct, warn: g.used >= g.budget * 0.85 };
  } catch {
    return null;
  }
}

/** 页面用的分级原始节点（跨项目）。字段与 tiering.js 的判据对齐。 */
function tierNodesOf(store) {
  if (!store || !store.db) return [];
  const rows = store.db
    .prepare("SELECT id, kind, pin, hits, created, claim FROM node WHERE state='active' AND valid_to IS NULL")
    .all();
  const now = Date.now();
  return rows.map((row) => ({
    id: row.id,
    claim: String(row.claim || ''),
    kind: row.kind,
    pin: row.pin === 1,
    hits: row.hits,
    ageDays: (now - Number(row.created || 0)) / 86400000,
  }));
}

/** 可回收候选（低层 + 非钉住 + 无命中 + 够老），带标题给用户看。 */
function tierCandidatesOf(store) {
  try {
    const nodes = tierNodesOf(store);
    const ids = new Set(collectionCandidates(nodes, GC_DEFAULTS).map((n) => n.id));
    return nodes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, claim: n.claim.slice(0, 80), ageDays: Math.round(n.ageDays) }));
  } catch (error) {
    return { error: (error && error.message) || String(error) };
  }
}

/** 回收：只翻 state，与 graph-memory 的 retire 语句同条件（非钉住、仅 active）。 */
function retireIds(store, ids) {
  if (!store || !store.db || !Array.isArray(ids) || !ids.length) return 0;
  const stmt = store.db.prepare("UPDATE node SET state='retired', seen=? WHERE id=? AND pin=0 AND state='active'");
  const now = Date.now();
  let changed = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue;
    changed += stmt.run(now, id).changes ? 1 : 0;
  }
  return changed;
}

/** 恢复：只翻回 active，且不碰已被取代（valid_to 非空）的节点。 */
function restoreIds(store, ids) {
  if (!store || !store.db || !Array.isArray(ids) || !ids.length) return 0;
  const stmt = store.db.prepare("UPDATE node SET state='active', seen=? WHERE id=? AND state='retired' AND valid_to IS NULL");
  const now = Date.now();
  let changed = 0;
  for (const id of ids) {
    if (typeof id !== 'string' || !id) continue;
    changed += stmt.run(now, id).changes ? 1 : 0;
  }
  return changed;
}

/** 规则逐条列表（与 coding_rules 的解析同一函数，避免两套解析漂移）；带子行供页面预填编辑框。 */
function rulesListOf() {
  try {
    return readGlobalRuleBlocks().map((item) => ({
      text: item.text,
      why: item.why,
      pitfall: item.pitfall,
      chars: item.text.length,
    }));
  } catch {
    return [];
  }
}

function countFiles(dir, suffix) {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(suffix)).length;
  } catch {
    return 0;
  }
}

/** 页头体检卡：只聚合已有数据，不新增存储。 */
function healthOf(store, tiers, usage, pendingCount) {
  const out = {
    coreBytes: 0,
    notes: countFiles(memoryPath('notes'), '.md'),
    nodes: 0,
    pending: pendingCount,
    rulesPct: usage ? usage.pct : 0,
    rulesWarn: !!(usage && usage.warn),
    collectable: (tiers && tiers.collectable) || 0,
  };
  try {
    out.coreBytes = readFileSync(memoryPath('MEMORY.md'), 'utf8').length;
  } catch { /* 还没写过核心记忆 */ }
  try {
    out.nodes = store && store.db ? store.db.prepare("SELECT COUNT(*) AS n FROM node WHERE state='active'").get().n : 0;
  } catch { /* 库不可用就不显示节点数 */ }
  return out;
}

/**
 * 注册设置页接口。
 * @param {object} ctx Cordis 上下文（已确认 webServer 可用）
 * @param {{ store?: object }} deps
 */
export function registerSoulUiRoutes(ctx, deps = {}) {
  const store = deps.store || null;
  const budget = deps.budget ?? null;

  const state = async () => {
    const pending = await proposedRules();
    const rules = readRulesText();
    const tiers = tierOverview(store);
    const usage = rulesUsageOf(budget);
    const pendingList = pending.ok ? pending.list : [];
    const dreaming = await readDreamingState().catch(() => null);
    return {
      ui: readUiSettings(),
      token: WRITE_TOKEN,
      limits: { maxNickname: MAX_NICKNAME, maxCustom: MAX_CUSTOM_TEXT, minRulesBudget: MIN_RULES_BUDGET, maxRulesBudget: MAX_RULES_BUDGET },
      pending: pendingList,
      pendingError: pending.ok ? null : pending.error,
      rules: rules.text,
      rulesError: rules.error,
      rulesList: rulesListOf(),
      rulesUsage: usage,
      persona: readPersona(),
      presets: listPresets(),
      tiers,
      tiersError: tiers.error || null,
      health: healthOf(store, tiers, usage, pendingList.length),
      dreaming: dreaming
        ? { enabled: !!dreaming.enabled, configured: !!dreaming.configured, corrupt: !!dreaming.corrupt, lastRunAt: dreaming.lastRunAt || null }
        : null,
    };
  };

  const disposers = []

  // Registering six routes by hand means a throw on the Nth leaks the first N-1, and the next
  // hot reload then fails because those paths are still taken. Roll back and rethrow.
  const mounted = []
  const route = (spec) => {
    try {
      const dispose = ctx.webServer.register(spec)
      mounted.push(dispose)
      return dispose
    } catch (error) {
      for (const stop of mounted.splice(0).reverse()) { try { stop() } catch { /* best effort */ } }
      throw error
    }
  };

  // GET /dsh-soul-memory/state
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'state',
    async handler(req, res) {
      try {
        if (!guard(req, res, false)) return;
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '该接口只支持 GET' });
          return;
        }
        sendJson(res, 200, await state());
      } catch (error) {
        console.error('dsh-soul-memory: 状态接口内部错误', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // POST /dsh-soul-memory/ui
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'ui',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return;
        if (!requireToken(req, res)) return;
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '该接口只支持 POST' });
          return;
        }
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const check = validateUiPatch(body.body);
        if (!check.ok) return sendJson(res, 400, { error: check.error });
        if (Object.keys(check.patch).length === 0) {
          res.statusCode = 204;
          res.end();
          return;
        }
        const ui = await writeUiSettings(check.patch);
        sendJson(res, 200, { ui });
      } catch (error) {
        console.error('dsh-soul-memory: 界面设置写入失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // POST /dsh-soul-memory/pending
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'pending',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return;
        if (!requireToken(req, res)) return;
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '该接口只支持 POST' });
          return;
        }
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const { action, ids, id, text } = body.body;
        if (action === 'edit') {
          if (typeof id !== 'string' || !id) return sendJson(res, 400, { error: 'edit 需要 id' });
          if (typeof text !== 'string') return sendJson(res, 400, { error: 'edit 需要 text' });
          const result = await editPendingRule(id, text);
          if (!result.ok) return sendJson(res, 400, { error: result.error, result });
          return sendJson(res, 200, { ok: true, action, result });
        }
        if (action !== 'approve' && action !== 'reject') {
          return sendJson(res, 400, { error: 'action 只能是 approve / reject / edit' });
        }
        if (!Array.isArray(ids) || ids.length === 0 || ids.some((id) => typeof id !== 'string')) {
          return sendJson(res, 400, { error: 'ids 必须是非空字符串数组' });
        }
        if (ids.length > MAX_PENDING_IDS) {
          return sendJson(res, 400, { error: `一次最多处理 ${MAX_PENDING_IDS} 条` });
        }
        const result = action === 'approve' ? await approveRules(ids) : await rejectRules(ids);
        // 一条都没成功才报错；部分成功要把 applied/failed 原样交给前端，别让用户以为全成了。
        if (!result.ok) return sendJson(res, 400, { error: result.error, result });
        sendJson(res, 200, { ok: true, action, result });
      } catch (error) {
        console.error('dsh-soul-memory: 待批操作失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // POST /dsh-soul-memory/tier —— 分级回收：预演 / 回收 / 恢复
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'tier',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return;
        if (!requireToken(req, res)) return;
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '该接口只支持 POST' });
          return;
        }
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const { action, ids: wanted, minAgeDays } = body.body;
        if (action === 'preview') {
          const opts = { ...GC_DEFAULTS };
          if (Number.isFinite(minAgeDays) && minAgeDays > 0) opts.minAgeDays = minAgeDays;
          const nodes = tierNodesOf(store);
          const ids = new Set(collectionCandidates(nodes, opts).map((n) => n.id));
          const candidates = nodes
            .filter((n) => ids.has(n.id))
            .map((n) => ({ id: n.id, claim: n.claim.slice(0, 80), ageDays: Math.round(n.ageDays) }));
          return sendJson(res, 200, { ok: true, action, candidates, count: candidates.length, minAgeDays: opts.minAgeDays });
        }
        if (action === 'collect') {
          const candidates = tierCandidatesOf(store);
          if (candidates && candidates.error) return sendJson(res, 500, { error: '统计失败，详情见宿主日志' });
          // 只允许回收当前候选里的：传了 ids 也不能越过判据。
          const allowed = new Set(candidates.map((c) => c.id));
          const target = Array.isArray(wanted) && wanted.length
            ? wanted.filter((id) => typeof id === 'string' && allowed.has(id))
            : candidates.map((c) => c.id);
          const collected = retireIds(store, target);
          return sendJson(res, 200, { ok: true, action, collected, ids: target });
        }
        if (action === 'restore') {
          if (!Array.isArray(wanted) || !wanted.length) return sendJson(res, 400, { error: 'restore 需要 ids' });
          if (wanted.length > MAX_PENDING_IDS) return sendJson(res, 400, { error: `一次最多恢复 ${MAX_PENDING_IDS} 条` });
          const restored = restoreIds(store, wanted);
          return sendJson(res, 200, { ok: true, action, restored, ids: wanted.filter((id) => typeof id === 'string') });
        }
        sendJson(res, 400, { error: 'action 只能是 preview / collect / restore' });
      } catch (error) {
        console.error('dsh-soul-memory: 分级操作失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // POST /dsh-soul-memory/rules —— 删除一条全局规则（完全匹配）
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'rules',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return;
        if (!requireToken(req, res)) return;
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '该接口只支持 POST' });
          return;
        }
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const { action, text, nextText, why, pitfall } = body.body;
        if (action === 'forget') {
          if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'forget 需要 text' });
          const result = await forgetRule(text);
          if (!result.ok) return sendJson(res, 400, { error: result.error, result });
          return sendJson(res, 200, { ok: true, removed: result.removed, usage: rulesUsageOf(budget) });
        }
        if (action === 'edit') {
          if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'edit 需要 text（原规则）' });
          if (typeof nextText !== 'string' || !nextText.trim()) return sendJson(res, 400, { error: 'edit 需要 nextText（改后的规则）' });
          const result = await editRule(text, { text: nextText, why, pitfall });
          if (!result.ok) return sendJson(res, 400, { error: result.error, code: result.code, result });
          return sendJson(res, 200, { ok: true, rule: result.rule, similar: result.similar, usage: rulesUsageOf(budget) });
        }
        sendJson(res, 400, { error: 'action 只能是 forget / edit' });
      } catch (error) {
        console.error('dsh-soul-memory: 删除规则失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // POST /dsh-soul-memory/dreaming —— 闲时整理开关
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'dreaming',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return;
        if (!requireToken(req, res)) return;
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: '该接口只支持 POST' });
          return;
        }
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const { enabled } = body.body;
        if (typeof enabled !== 'boolean') return sendJson(res, 400, { error: 'enabled 必须是布尔值' });
        let next;
        try {
          next = await withDreamingRunLock(() => writeDreamingState({ enabled }));
        } catch {
          return sendJson(res, 409, { error: '正在整理中，稍后再试' });
        }
        sendJson(res, 200, { ok: true, dreaming: { enabled: !!next.enabled } });
      } catch (error) {
        console.error('dsh-soul-memory: 闲时整理开关失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try { dispose(); } catch { /* 已释放 */ }
    }
  };
}
