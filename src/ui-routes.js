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
import { codingPath, proposedRules, approveRules, rejectRules, editPendingRule, editRule, forgetRule, addRule, readGlobalRules, similarRules, readGlobalRuleBlocks, collectRules } from './coding.js';
import { exportBundle, listBackups, readBundle, importBundle } from './backup.js';
import { runDreaming } from './core-memory.js';
import { readUiSettings, writeUiSettings, validateUiPatch, MAX_NICKNAME, MIN_RULES_BUDGET, MAX_RULES_BUDGET } from './ui-settings.js';
import { readPersona, listPresets, MAX_CUSTOM_TEXT } from './persona.js';
import { GC_DEFAULTS, tierCounts, collectionCandidates } from './tiering.js';
import { MODE_LABELS, SESSION_MODES, listModes, modeOf, setMode } from './session-modes.js';
import { atomicWrite, memoryPath, withFileLock } from './memory/util.js';
import { readDreamingState, writeDreamingState, withDreamingRunLock } from './dreaming.js';
import { readTurns } from './turnlog.js';
import { BAND_LABELS, scoreText } from './weighting.js';
import { TOPIC_LABELS, TOPICS, normalizeTopic, topicOf } from './topics.js';
import { GUARD_HEADER, TOKEN_HEADER, WRITE_TOKEN, guard, isLoopbackHost, requireToken, sendJson } from './memory/web-guard.js';

const PREFIX = '/dsh-soul-memory/';
const BODY_LIMIT = 64 * 1024; // 待批批量操作与规则预览；与 persona 的 16KB 不同是有意的（批量批准）。
const MAX_PENDING_IDS = 40; // 待批上限 20，留一倍余量，防止构造超长 ids。


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
/**
 * 记忆内容只读快照：归档笔记（标题 + 字数）、踩坑条数、最近几天的回合日志。
 * 页面只负责「让人看见记住了什么」；写入和删除仍走模型工具，避免第二个写源。
 */
async function memoriesOf() {
  const notes = [];
  try {
    for (const name of readdirSync(memoryPath('notes'))) {
      if (!name.endsWith('.md')) continue;
      const text = readFileSync(join(memoryPath('notes'), name), 'utf8');
      // 笔记头是 front matter，标题在 title: 行；没有才退回一级标题或文件名。
      const titleLine = text.split('\n').find((line) => /^title:\s*\S/.test(line)) || '';
      const heading = text.split('\n').find((line) => line.startsWith('# ')) || '';
      const fallback = name.replace(/\.md$/, '');
      const body = text.replace(/^---[\s\S]*?---\r?\n?/, '');
      const weight = scoreText(String(titleLine || heading || fallback) + ' ' + body);
      // 老笔记没有 topic 行：按同一套词表现算，但不回写文件（这里是只读快照）。
      const topicLine = text.split('\n').find((line) => /^topic:\s*\S/.test(line)) || '';
      const declared = topicLine ? topicLine.replace(/^topic:\s*/, '').trim() : '';
      const topic = declared ? normalizeTopic(declared) : topicOf(String(titleLine || heading || fallback) + ' ' + body).topic;
      // front matter 一次解析：记忆流要按日期分组，也要标出敏感/已被取代/墓碑。
      const head = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1] || '';
      const fieldOf = (key) => {
        const hit = head.split('\n').find((line) => line.startsWith(key + ':'));
        return hit ? hit.slice(key.length + 1).trim() : '';
      };
      notes.push({
        id: fallback,
        title: titleLine
          ? titleLine.replace(/^title:\s*/, '').trim()
          : heading ? heading.replace(/^#\s*/, '').trim() : fallback,
        chars: text.length,
        topic,
        topicLabel: TOPIC_LABELS[topic] || TOPIC_LABELS.other,
        score: weight.score,
        band: weight.band,
        bandLabel: BAND_LABELS[weight.band] || weight.band,
        created: fieldOf('created'),
        tags: fieldOf('tags') ? fieldOf('tags').split(',').map((tag) => tag.trim()).filter(Boolean) : [],
        session: fieldOf('session'),
        supersededBy: fieldOf('supersededBy'),
        sensitive: fieldOf('sensitive') === 'true',
        deleted: fieldOf('deleted') === 'true',
      });
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') console.error('dsh-soul-memory: 读取归档笔记失败', error);
  }
  // 与 memory_list 用同一把尺子：先按分量，分数相同再看字数。
  notes.sort((a, b) => b.score - a.score || b.chars - a.chars);

  let lessons = 0;
  try {
    lessons = readFileSync(memoryPath('LESSONS.jsonl'), 'utf8').split('\n').filter((line) => line.trim()).length;
  } catch { /* 还没有记录就是 0 */ }

  let journal = [];
  try {
    journal = await readTurns({ days: 5 });
  } catch { journal = []; }

  // 各主题的条数，供页面画筛选按钮；只列真正有笔记的主题。
  const counts = new Map();
  for (const note of notes) counts.set(note.topic, (counts.get(note.topic) || 0) + 1);
  const topics = TOPICS.filter((id) => counts.get(id)).map((id) => ({ id, label: TOPIC_LABELS[id], count: counts.get(id) }));

  return {
    notes: notes.slice(0, 200),
    topics,
    lessons,
    journal: journal.map((entry) => ({ name: entry.name.replace(/\.md$/, ''), text: entry.text })),
  };
}

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
          const opts = { ...GC_DEFAULTS };
          if (Number.isFinite(minAgeDays) && minAgeDays > 0) opts.minAgeDays = Math.max(7, Math.round(minAgeDays));
          const nodes = tierNodesOf(store);
          const allowed = new Set(collectionCandidates(nodes, opts).map((n) => n.id));
          // 只允许回收当前候选里的：传了 ids 也不能越过判据。
          const target = Array.isArray(wanted) && wanted.length
            ? wanted.filter((id) => typeof id === 'string' && allowed.has(id))
            : [...allowed];
          const collected = retireIds(store, target);
          return sendJson(res, 200, { ok: true, action, collected, ids: target, minAgeDays: opts.minAgeDays });
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
        if (action === 'add') {
          if (typeof text !== 'string' || !text.trim()) return sendJson(res, 400, { error: 'add 需要 text' });
          const result = await addRule(text, { why, pitfall });
          if (!result.ok) return sendJson(res, 400, { error: result.error, code: result.code, similar: result.similar });
          return sendJson(res, 200, { ok: true, rule: result.rule, similar: result.similar, usage: rulesUsageOf(budget) });
        }
        if (action === 'dupes') {
          const rules = readGlobalRules().map((row) => row.rule);
          const pairs = [];
          for (let i = 0; i < rules.length && pairs.length < 8; i += 1) {
            const rest = rules.filter((_, j) => j !== i);
            for (const hit of similarRules(rules[i], rest, { threshold: 0.25, limit: 1 })) {
              pairs.push({ a: rules[i].slice(0, 60), b: hit.rule.slice(0, 60), score: Math.round(hit.score * 100) / 100 });
            }
          }
          return sendJson(res, 200, { ok: true, count: rules.length, pairs });
        }
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
        sendJson(res, 400, { error: 'action 只能是 forget / edit / add / dupes' });
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
        const { enabled, action } = body.body;
        if (action === 'run') {
          const apply = body.body.apply === true;
          let result;
          try {
            // runDreaming 内部已经持锁（进程内 + 跨进程），这里再包一层会永远拿不到锁。
            result = await runDreaming({ apply });
          } catch {
            return sendJson(res, 409, { error: '正在整理中，稍后再试' });
          }
          return sendJson(res, 200, { ok: true, action: 'run', result, usage: rulesUsageOf(budget) });
        }
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

  // /dsh-soul-memory/backup —— 备份：GET 列表；POST 导出 / 预演导入 / 真正导入
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'backup',
    async handler(req, res) {
      try {
        if (!guard(req, res, req.method === 'POST')) return;
        if (req.method === 'GET') {
          return sendJson(res, 200, { ok: true, backups: await listBackups({ limit: 20 }) });
        }
        if (req.method !== 'POST') {
          return sendJson(res, 405, { error: '该接口只支持 GET / POST' });
        }
        if (!requireToken(req, res)) return;
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const { action, file, apply } = body.body;
        if (action === 'export') {
          const result = await exportBundle();
          return sendJson(res, 200, { ok: true, action, result });
        }
        if (action === 'import') {
          if (typeof file !== 'string' || !file.trim()) return sendJson(res, 400, { error: 'import 需要 file' });
          let bundle;
          try {
            bundle = await readBundle(file.trim());
          } catch (error) {
            // 读/解析备份失败的原始 message 里带用户目录的绝对路径（磁盘符 + 用户名），
            // 而浏览器端的错误可能被截图贴出来。细节只进宿主日志，回给页面一句能行动的提示。
            console.error('dsh-soul-memory: 读取备份失败', error);
            const code = error && error.code;
            const reason = code === 'ENOENT'
              ? '没有这个备份文件（用 action=list 看有哪些）'
              : '这个文件读不成备份（不是本插件导出的 JSON，或已损坏）';
            return sendJson(res, 400, { error: reason });
          }
          const result = await importBundle(bundle, { apply: apply === true });
          return sendJson(res, 200, { ok: true, action, apply: apply === true, result });
        }
        return sendJson(res, 400, { error: 'action 只能是 export / import' });
      } catch (error) {
        console.error('dsh-soul-memory: 备份操作失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // POST /dsh-soul-memory/notes —— 单条归档笔记：读正文 / 保存正文 / 删除（写墓碑，不物理删）
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'notes',
    async handler(req, res) {
      try {
        if (!guard(req, res, true)) return;
        if (!requireToken(req, res)) return;
        if (req.method !== 'POST') return sendJson(res, 405, { error: '该接口只支持 POST' });
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const { action, id } = body.body;
        if (typeof id !== 'string' || !/^[A-Za-z0-9._-]+$/.test(id) || id.includes('..')) {
          return sendJson(res, 400, { error: 'id 不合法' });
        }
        const name = id.endsWith('.md') ? id : id + '.md';
        const file = join(memoryPath('notes'), name);
        let text;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          return sendJson(res, 404, { error: '没有这条笔记' });
        }
        const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
        const head = match ? match[0] : '';
        const meta = match ? match[1] : '';
        const bodyText = match ? text.slice(match[0].length) : text;
        if (action === 'read') {
          return sendJson(res, 200, { ok: true, id, meta, body: bodyText.replace(/^\r?\n/, ''), deleted: /^deleted:\s*true/m.test(meta) });
        }
        if (action === 'save') {
          if (typeof body.body.bodyText !== 'string') return sendJson(res, 400, { error: 'save 需要 bodyText' });
          if (body.body.bodyText.length > 60000) return sendJson(res, 400, { error: '正文太长（上限 6 万字符）' });
          const stamp = new Date().toISOString();
          let nextMeta = meta;
          if (/^updated:.*$/m.test(nextMeta)) nextMeta = nextMeta.replace(/^updated:.*$/m, 'updated: ' + stamp);
          else nextMeta = nextMeta + '\nupdated: ' + stamp;
          // 用户直接编辑的这条路径也必须原子写：writeFileSync 截断式写入遇到断电/写满会留下半截正文，
          // 而下一次成功保存又会用这半截覆盖唯一的 .bak，原文就永远没了。
          await withFileLock(file, async () => {
            await atomicWrite(file + '.bak', text);
            await atomicWrite(file, '---\n' + nextMeta + '\n---\n\n' + body.body.bodyText);
          });
          return sendJson(res, 200, { ok: true, id, saved: true });
        }
        if (action === 'delete') {
          let nextMeta = /^deleted:.*$/m.test(meta)
            ? meta.replace(/^deleted:.*$/m, 'deleted: true')
            : meta + '\ndeleted: true';
          await withFileLock(file, async () => {
            await atomicWrite(file + '.bak', text);
            await atomicWrite(file, '---\n' + nextMeta + '\n---\n\n（此记忆已删除）');
          });
          return sendJson(res, 200, { ok: true, id, deleted: true });
        }
        return sendJson(res, 400, { error: 'action 只能是 read / save / delete' });
      } catch (error) {
        console.error('dsh-soul-memory: 笔记操作失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // GET /dsh-soul-memory/memories —— 记忆内容只读快照
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'memories',
    async handler(req, res) {
      try {
        if (!guard(req, res, false)) return;
        if (req.method !== 'GET') {
          sendJson(res, 405, { error: '该接口只支持 GET' });
          return;
        }
        sendJson(res, 200, await memoriesOf());
      } catch (error) {
        console.error('dsh-soul-memory: 读取记忆内容失败', error);
        sendJson(res, 500, { error: '服务器内部错误，详情见宿主日志' });
      }
    },
  }));

  // 会话级记忆开关：只影响单个会话，换新会话自动回到正常。
  disposers.push(route({
    kind: 'exact',
    path: PREFIX + 'session',
    async handler(req, res) {
      try {
        if (!guard(req, res, req.method === 'POST')) return;
        if (req.method === 'GET') {
          const sid = new URL(req.url ?? '/', 'http://dsh.internal').searchParams.get('session') || '';
          sendJson(res, 200, {
            modes: listModes(),
            labels: MODE_LABELS,
            options: SESSION_MODES,
            session: sid,
            mode: sid ? modeOf(sid) : 'normal',
          });
          return;
        }
        if (req.method !== 'POST') { sendJson(res, 405, { error: '该接口只支持 GET / POST' }); return; }
        if (!requireToken(req, res)) return;
        const body = await readJsonBody(req);
        if (body.error) return sendJson(res, 400, { error: '请求体读取失败' });
        if (body.tooLarge) return sendJson(res, 413, { error: '请求体过大' });
        if (!body.body) return sendJson(res, 400, { error: '请求体必须是 JSON 对象' });
        const sid = String(body.body.session ?? '').trim();
        const mode = String(body.body.mode ?? '').trim();
        if (!sid) { sendJson(res, 400, { error: 'session 必填' }); return; }
        if (!SESSION_MODES.includes(mode)) {
          sendJson(res, 400, { error: 'mode 只能是 normal / readonly / off' });
          return;
        }
        await setMode(sid, mode);
        sendJson(res, 200, { session: sid, mode, label: MODE_LABELS[mode] });
      } catch (error) {
        console.error('dsh-soul-memory: 会话记忆开关失败', error);
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
