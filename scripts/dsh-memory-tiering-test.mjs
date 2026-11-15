// 分级 + 回收（tier + GC）自检。
//
// 两层验证：
// 1. tiering.js 的纯函数判据（kind → tier、回收门槛）；
// 2. registerCoreMemory 注册出来的 memory_tier 工具（status / collect dry-run / collect apply / restore）。
//    集成测试用假的 graphNodes / retireNodes / restoreNodes，只验证工具把哪些 id 交给了回收器。
import { makeHome, makeCtx, suite, callTool, assert } from './_testkit.mjs';
import { TIERS, tierOf, tierCounts, collectionCandidates, tierSummary, GC_DEFAULTS } from '../src/tiering.js';
import { registerCoreMemory } from '../src/core-memory.js';

const home = await makeHome();
const s = suite('dsh-memory-tiering');
let retired = [];
let restored = [];

try {
  await s.test('TIERS 固定三层', () => {
    assert.deepEqual(TIERS, ['high', 'medium', 'low']);
  });

  await s.test('kind → tier 映射', () => {
    assert.equal(tierOf({ kind: 'constraint' }), 'high');
    assert.equal(tierOf({ kind: 'decision' }), 'medium');
    assert.equal(tierOf({ kind: 'progress' }), 'medium');
    assert.equal(tierOf({ kind: 'artifact' }), 'low');
    assert.equal(tierOf({ kind: 'reference' }), 'low');
    assert.equal(tierOf({ kind: '未知kind' }), 'low');
    assert.equal(tierOf(null), 'low');
  });

  await s.test('pin 优先于 kind，永远归高', () => {
    assert.equal(tierOf({ kind: 'artifact', pin: true }), 'high');
  });

  await s.test('tierCounts 分层计数', () => {
    const counts = tierCounts([
      { kind: 'constraint' },
      { kind: 'decision' },
      { kind: 'artifact' },
      { kind: 'reference' },
      { kind: 'artifact', pin: true },
    ]);
    assert.deepEqual(counts, { high: 2, medium: 1, low: 2 });
    assert.deepEqual(tierCounts(null), { high: 0, medium: 0, low: 0 });
  });

  await s.test('默认门槛是 90 天', () => {
    assert.equal(GC_DEFAULTS.minAgeDays, 90);
  });

  await s.test('回收只从低层且信号齐全的节点里挑', () => {
    const candidates = collectionCandidates([
      { id: 'constraint', kind: 'constraint', hits: 0, ageDays: 999, importance: 12 },
      { id: 'recent', kind: 'artifact', hits: 0, ageDays: 10, importance: 3 },
      { id: 'hot', kind: 'artifact', hits: 3, ageDays: 999, importance: 3 },
      { id: 'old', kind: 'artifact', hits: 0, ageDays: 200, importance: 3 },
      { id: 'pinned', kind: 'artifact', pin: true, hits: 0, ageDays: 999, importance: 1000 },
      { id: 'heavy', kind: 'artifact', hits: 0, ageDays: 999, importance: 9 },
    ]).map(n => n.id);
    assert.deepEqual(candidates, ['old']);
  });

  await s.test('minAgeDays 可覆盖', () => {
    const rows = collectionCandidates([
      { id: 'a', kind: 'artifact', hits: 0, ageDays: 8, importance: 2 },
    ], { minAgeDays: 7 }).map(n => n.id);
    assert.deepEqual(rows, ['a']);
  });

  await s.test('tierSummary 输出三层与可回收数', () => {
    const line = tierSummary({ high: 2, medium: 3, low: 5 }, 4);
    assert.match(line, /🔴 高 2/);
    assert.match(line, /🟡 中 3/);
    assert.match(line, /🟢 低 5/);
    assert.match(line, /可回收 4 条/);
  });

  // ---- 工具层 ----
  const { ctx, tools } = makeCtx();
  const nodes = [
    { id: 'c1', kind: 'constraint', pin: false, hits: 0, ageDays: 300, importance: 12, claim: '必须用 pnpm' },
    { id: 'd1', kind: 'decision', pin: false, hits: 0, ageDays: 300, importance: 6, claim: '选 Vite' },
    { id: 'a1', kind: 'artifact', pin: false, hits: 0, ageDays: 200, importance: 3, claim: '旧构建产物' },
    { id: 'r1', kind: 'reference', pin: false, hits: 2, ageDays: 200, importance: 2, claim: '被引用过' },
    { id: 'a2', kind: 'artifact', pin: false, hits: 0, ageDays: 10, importance: 3, claim: '新产物' },
    { id: 'a3', kind: 'artifact', pin: false, hits: 0, ageDays: 120, importance: 3, claim: '真正的候选' },
  ];
  registerCoreMemory(ctx, {
    core: true,
    graphNodes: async () => nodes,
    retireNodes: (_agent, ids) => { retired = ids.slice(); return ids.length; },
    restoreNodes: (_agent, ids) => { restored = ids.slice(); return ids.length; },
  });

  await s.test('注册了 memory_tier 工具', () => {
    assert.ok(tools.get('memory_tier'), 'memory_tier 未注册');
  });

  await s.test('status 给出分级与候选，但不改库', async () => {
    retired = [];
    const text = await callTool(tools, 'memory_tier', { action: 'status' });
    assert.match(text, /记忆分级/);
    assert.match(text, /🔴 高 1/);
    assert.match(text, /🟡 中 1/);
    assert.match(text, /🟢 低 4/);
    assert.match(text, /可回收（🟢 层、无人命中、≥90 天）：2 条/);
    assert.ok(text.includes('a1') && text.includes('a3'), '候选应包含 a1/a3');
    assert.deepEqual(retired, []);
  });

  await s.test('collect 默认 dry-run，不调回收器', async () => {
    retired = [];
    const text = await callTool(tools, 'memory_tier', { action: 'collect' });
    assert.match(text, /回收预演/);
    assert.ok(text.includes('a1') && text.includes('a3'));
    assert.deepEqual(retired, []);
  });

  await s.test('collect apply=true 只把低层候选交给回收器', async () => {
    retired = [];
    const text = await callTool(tools, 'memory_tier', { action: 'collect', apply: true });
    assert.match(text, /已回收 2 个节点/);
    assert.deepEqual(retired.sort(), ['a1', 'a3']);
  });

  await s.test('collect 无候选时不动库', async () => {
    const { ctx: ctx2, tools: tools2 } = makeCtx();
    let called = 0;
    registerCoreMemory(ctx2, {
      core: true,
      graphNodes: async () => [{ id: 'x', kind: 'constraint', hits: 0, ageDays: 500, importance: 12 }],
      retireNodes: () => { called += 1; return 0; },
    });
    const text = await callTool(tools2, 'memory_tier', { action: 'collect', apply: true });
    assert.match(text, /没有可回收的节点/);
    assert.equal(called, 0);
  });

  await s.test('restore 把 id 交给恢复器', async () => {
    restored = [];
    const text = await callTool(tools, 'memory_tier', { action: 'restore', ids: ['a1', 'a3'] });
    assert.match(text, /已恢复 2 个节点/);
    assert.deepEqual(restored.sort(), ['a1', 'a3']);
  });

  await s.test('restore 缺 ids 时明确报参数错误', async () => {
    const text = await callTool(tools, 'memory_tier', { action: 'restore' });
    assert.match(text, /\[err:E_ARG\]/);
  });

  await s.test('未知 action 报错而不是静默成功', async () => {
    const text = await callTool(tools, 'memory_tier', { action: 'nope' });
    assert.match(text, /\[err:E_ARG\]/);
  });
} finally {
  // bootstrap 是异步 enqueue 的：先让它落盘，再删临时 home，否则会留下 ENOENT 噪声。
  await new Promise(r => setTimeout(r, 80));
  await home.cleanup();
}

s.finish();
