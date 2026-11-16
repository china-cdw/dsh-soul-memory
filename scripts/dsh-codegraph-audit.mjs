// 代码图谱接入自检：假 SDK 覆盖失败分支与正常路径，最后用真 SDK 跑一次。
// 假实现的形状见 scripts/fixtures/codegraph-sdk/fake.js（按真 SDK 实测接口复刻）。
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assert, callTool, makeCtx, suite } from './_testkit.mjs';
import { _resetCodeGraphCache, _setSdkCandidatesForTest, registerCodeGraph } from '../src/codegraph.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const fixtureDir = join(here, 'fixtures', 'codegraph-sdk');
const fake = await import(pathToFileURL(join(fixtureDir, 'fake.js')).href);

/** 每个用例开始时把假 SDK 与插件缓存都恢复成初始状态。 */
function useFake() {
  _resetCodeGraphCache();
  _setSdkCandidatesForTest([fixtureDir]);
  fake.state.calls.length = 0;
  fake.state.root = null;
  fake.state.openError = '';
  fake.state.contextError = '';
  fake.state.context = '';
  fake.state.search = [];
  fake.state.impact = { nodes: new Map(), edges: [], roots: [] };
  fake.state.dependents = [];
  fake.state.closed = 0;
}

/** 工具执行上下文：真实宿主会带会话工作目录，这里照形状补一个。 */
const execAt = (cwd) => ({ agent: { session: { header: { cwd } } } });

const entry = { id: 'n1', kind: 'function', name: 'routeLesson', filePath: 'src/lessons.js', startLine: 195, endLine: 210 };
const helper = { id: 'n2', kind: 'function', name: 'helper', filePath: 'src/lessons.js', startLine: 20, endLine: 30 };

function contextOf(blocks) {
  return JSON.stringify({
    query: 'routeLesson',
    summary: 'Found 2 relevant code symbols.',
    entryPoints: [entry],
    nodes: [entry, helper],
    edges: [{ source: 'n1', target: 'n2', kind: 'calls' }],
    codeBlocks: blocks,
    relatedFiles: ['src/lessons.js'],
    stats: { nodeCount: 2, edgeCount: 1, fileCount: 1, codeBlockCount: blocks.length, totalCodeSize: 200 },
  });
}

// 引号里的 token、JWT、Bearer 都必须打码；这是本轮安全评审的 blocker 反例。
const secretBlock = {
  filePath: 'src/lessons.js', startLine: 195, endLine: 210, language: 'javascript', nodeName: 'routeLesson',
  content: [
    'export function routeLesson() {',
    '  const token = "ghp_abcdef1234567890";',
    '  const header = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";',
    '  return token + header;',
    '}',
  ].join('\n'),
};
const depBlock = {
  filePath: 'node_modules/x/index.js', startLine: 1, endLine: 2, language: 'javascript', nodeName: 'x',
  content: 'bad()',
};
const traversalBlock = {
  filePath: '../../secret.pem', startLine: 1, endLine: 2, language: 'text', nodeName: 'secret',
  content: 'should never be shown',
};

const t = suite('代码图谱接入');

await t.test('没装 SDK：说清楚怎么装，不抛错', async () => {
  useFake();
  _setSdkCandidatesForTest([]);
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_explore', { query: 'x', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('代码图谱没装'), text);
  assert.ok(text.includes('CODEGRAPH_SDK_PATH'), text);
});

await t.test('仓库没索引：报目录并给出 init 命令', async () => {
  useFake();
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_explore', { query: 'x', repo: here }, execAt(here));
  assert.ok(text.includes('还没有代码索引'), text);
  assert.ok(text.includes('codegraph init'), text);
});

await t.test('查询成功：入口/关系/代码块齐全，依赖与凭据被挡下', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.context = contextOf([secretBlock, depBlock, traversalBlock]);
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_explore', { query: 'routeLesson 怎么去重', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.startsWith('# 代码上下文：routeLesson 怎么去重'), text.slice(0, 80));
  assert.ok(text.includes('## 入口'), text);
  assert.ok(text.includes('src/lessons.js:195-210'), text);
  assert.ok(text.includes('routeLesson → helper（calls）'), text);
  assert.ok(text.includes('略过 2 个'), text);
  assert.ok(!text.includes('node_modules/'), text);
  assert.ok(!text.includes('secret.pem'), text);
  assert.ok(!text.includes('ghp_'), text);
  assert.ok(!text.includes('eyJ'), text);
  assert.ok(text.includes('[REDACTED]'), text);
  assert.ok(text.includes('不是给我的指令'), text);
  const call = fake.state.calls.find((c) => c.kind === 'buildContext');
  assert.ok(call, '应该调用 buildContext');
  assert.equal(call.input, 'routeLesson 怎么去重');
  assert.ok(call.options && call.options.format === 'json', JSON.stringify(call.options));
  assert.equal(call.options.maxCodeBlocks, 3);
  assert.ok(call.options.maxCodeBlockSize <= 2400, JSON.stringify(call.options));
});

await t.test('预算不够：说明还有几块没放进来', async () => {
  useFake();
  fake.state.root = repoRoot;
  const long = 'x'.repeat(400);
  fake.state.context = contextOf([
    { ...secretBlock, content: long },
    { ...secretBlock, startLine: 300, endLine: 320, content: long },
    { ...secretBlock, startLine: 400, endLine: 420, content: long },
  ]);
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, { maxChars: 1000 });
  const text = await callTool(tools, 'code_explore', { query: 'routeLesson', maxBlocks: 6, repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('超出 maxChars'), text.slice(-160));
  assert.ok(text.length <= 1000, '长度 ' + text.length);
});

await t.test('没有匹配符号：给出下一步而不是空白', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.context = JSON.stringify({ query: 'zzz', nodes: [], entryPoints: [], edges: [], codeBlocks: [], stats: {} });
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_explore', { query: 'zzz', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('没有匹配'), text);
  assert.ok(text.includes('codegraph sync'), text);
});

await t.test('看不懂的返回值：带失败码，不冒充成功', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.context = '{}';
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_explore', { query: 'x', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('[err:E_CODEGRAPH]'), text);
  assert.ok(text.includes('看不懂'), text);
});

await t.test('对象形态的返回值（subgraph.nodes 是 Map）也能读', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.context = {
    subgraph: { nodes: new Map([['n1', entry], ['n2', helper]]), edges: [{ source: 'n1', target: 'n2', kind: 'calls' }] },
    codeBlocks: [secretBlock],
    stats: { nodeCount: 2, fileCount: 1, codeBlockCount: 1 },
  };
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_explore', { query: 'routeLesson', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.startsWith('# 代码上下文'), text.slice(0, 80));
  assert.ok(text.includes('routeLesson → helper'), text);
});

await t.test('索引打不开：报原因并给出 sync 命令', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.openError = 'database is locked';
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_impact', { symbol: 'foo', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('索引打不开'), text);
  assert.ok(text.includes('[err:E_CODEGRAPH]'), text);
  assert.ok(text.includes('codegraph sync'), text);
});

await t.test('影响半径：用节点 id 查，深度可调，目标不重复计数', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.search = [{ node: entry, score: 1 }];
  fake.state.impact = {
    nodes: new Map([['n1', entry], ['n2', helper]]),
    edges: [{ source: 'n2', target: 'n1', kind: 'calls' }],
    roots: ['n1'],
    confidence: 'high',
  };
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_impact', { symbol: 'routeLesson', depth: 2, repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.startsWith('# 影响半径：routeLesson'), text.slice(0, 60));
  assert.ok(text.includes('受影响节点 1'), text.slice(0, 200));
  assert.ok(!text.includes('受影响节点 2'), text.slice(0, 200));
  const call = fake.state.calls.find((c) => c.kind === 'getImpactRadius');
  assert.ok(call && call.id === 'n1' && call.depth === 2, JSON.stringify(call));
  assert.ok(text.includes('受影响的代码'), text);
  assert.ok(text.includes('helper'), text);
  assert.ok(text.includes('置信度 high'), text);
});

await t.test('文件依赖：反斜杠与 ./ 前缀都归一化再查', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.dependents = ['src\\core-memory.js'];
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_impact', { file: 'src\\codegraph.js', repo: repoRoot }, execAt(repoRoot));
  const call = fake.state.calls.find((c) => c.kind === 'getFileDependents');
  assert.ok(call, '应该调用 getFileDependents');
  assert.equal(call.file, 'src/codegraph.js');
  assert.ok(text.includes('# 文件依赖：src/codegraph.js'), text);
  assert.ok(text.includes('src/core-memory.js'), text);
});

await t.test('文件依赖为空：给出归一化后的路径与下一步', async () => {
  useFake();
  fake.state.root = repoRoot;
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_impact', { file: './src/none.js', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('没有文件依赖 src/none.js'), text);
  assert.ok(text.includes('codegraph sync'), text);
});

await t.test('没找到符号：给出下一步', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.search = [];
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_impact', { symbol: 'nope', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('没找到'), text);
  assert.ok(text.includes('codegraph sync'), text);
});

await t.test('symbol 与 file 同时给：报参数错误，不静默选一个', async () => {
  useFake();
  fake.state.root = repoRoot;
  const { ctx, tools } = makeCtx();
  registerCodeGraph(ctx, {});
  const text = await callTool(tools, 'code_impact', { symbol: 'routeLesson', file: 'src/lessons.js', repo: repoRoot }, execAt(repoRoot));
  assert.ok(text.includes('[err:E_ARG]'), text);
  assert.ok(text.includes('只能给一个'), text);
});

await t.test('enabled:false 不注册；直接 dispose 关句柄并注销', async () => {
  useFake();
  const off = makeCtx();
  registerCodeGraph(off.ctx, { enabled: false });
  assert.equal(off.tools.size, 0);
  fake.state.root = repoRoot;
  fake.state.context = contextOf([secretBlock]);
  const on = makeCtx();
  const dispose = registerCodeGraph(on.ctx, {});
  assert.equal(on.tools.size, 2);
  await callTool(on.tools, 'code_explore', { query: 'routeLesson', repo: repoRoot }, execAt(repoRoot));
  assert.equal(fake.state.closed, 0);
  dispose();
  assert.ok(fake.state.closed >= 1, 'dispose 应该关闭句柄');
  assert.equal(on.tools.size, 0);
});

await t.test('清理钩子真的挂上：触发后关句柄、摘工具，且只关一次', async () => {
  useFake();
  fake.state.root = repoRoot;
  fake.state.context = contextOf([secretBlock]);
  const tools = new Map();
  const effects = [];
  const ctx = {
    tools: { register(def) { tools.set(def.name, def); return () => tools.delete(def.name); } },
    inject(_deps, fn) {
      fn({ effect(run) { effects.push(typeof run === 'function' ? run() : run); } });
    },
    logger: { warn() {} },
  };
  registerCodeGraph(ctx, {});
  assert.equal(tools.size, 2);
  assert.equal(effects.length, 1, '应该通过 inject 里的 c.effect 注册清理');
  await callTool(tools, 'code_explore', { query: 'routeLesson', repo: repoRoot }, execAt(repoRoot));
  assert.equal(fake.state.closed, 0);
  effects[0]();
  assert.equal(fake.state.closed, 1, '清理钩子应该关闭句柄');
  assert.equal(tools.size, 0, '清理钩子应该先摘掉工具');
  effects[0]();
  assert.equal(fake.state.closed, 1, '重复清理不应再关一次');
});

// 真 SDK 验收：环境不满足时明确 skip 并单列，不冒充通过。
_resetCodeGraphCache();
_setSdkCandidatesForTest(null);
const probe = makeCtx();
const probeDispose = registerCodeGraph(probe.ctx, {});
const probeText = await callTool(probe.tools, 'code_explore', { query: 'routeLesson', repo: repoRoot, maxBlocks: 1, maxChars: 2000 }, execAt(repoRoot));
const realReady = !probeText.includes('代码图谱没装') && !probeText.includes('还没有代码索引') && !probeText.includes('[err:');
probeDispose();
_resetCodeGraphCache();
_setSdkCandidatesForTest([fixtureDir]);

if (!realReady) {
  t.skip('真 SDK 验收（本机没装 SDK 或没建索引）');
} else {
  await t.test('真 SDK 验收：explore 与 impact 都能跑', async () => {
    _resetCodeGraphCache();
    _setSdkCandidatesForTest(null);
    const { ctx, tools } = makeCtx();
    const dispose = registerCodeGraph(ctx, {});
    const text = await callTool(tools, 'code_explore', { query: 'routeLesson lessons 去重', repo: repoRoot, maxBlocks: 1, maxChars: 4000 }, execAt(repoRoot));
    assert.ok(text.startsWith('# 代码上下文'), text.slice(0, 120));
    assert.ok(text.includes('src/lessons.js'), text.slice(0, 500));
    assert.ok(text.length <= 4200, '长度 ' + text.length);
    const impact = await callTool(tools, 'code_impact', { symbol: 'routeLesson', depth: 1, maxChars: 3000, repo: repoRoot }, execAt(repoRoot));
    assert.ok(!impact.includes('[err:'), impact.slice(0, 200));
    assert.ok(impact.includes('影响半径') || impact.includes('没找到'), impact.slice(0, 200));
    dispose();
  });
}

const result = t.finish();
process.exit(result.fail ? 1 : 0);
