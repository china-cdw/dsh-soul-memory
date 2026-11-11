// 核心记忆层自检：注册、写入/查重/检索/删除、注入节、索引对账、锁、persona 路由。
//
// 运行：node scripts/dsh-memory-audit.mjs
// 环境：临时 DSH_HOME（不会碰真实记忆）。
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { assert, callTool, makeCtx, makeHome, suite, waitFor } from './_testkit.mjs';
import { registerCoreMemory } from '../src/core-memory.js';
import { readPersona } from '../src/persona.js';

const home = await makeHome('dsh-mem-core-');
const memoryDir = join(home.dir, 'memory');
const notesDir = join(memoryDir, 'notes');
const indexPath = join(memoryDir, 'index.json');
const t = suite('核心记忆自检');

const ctx1 = makeCtx();
registerCoreMemory(ctx1.ctx, {});
const tools1 = ctx1.tools;

async function readIndex() {
  return JSON.parse(await readFile(indexPath, 'utf8'));
}

async function noteFiles() {
  return (await readdir(notesDir)).filter((n) => n.endsWith('.md'));
}

function fakeReq({ method = 'GET', headers = {}, body = null } = {}) {
  const req = Readable.from(body === null ? [] : [Buffer.from(body)]);
  req.method = method;
  req.headers = headers;
  return req;
}

function fakeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; },
    end(chunk) { this.body = String(chunk ?? ''); },
  };
}

await t.test('启动 bootstrap 建好 MEMORY.md / index.json / notes/', async () => {
  await waitFor(async () => {
    await stat(indexPath);
    return true;
  }, { label: 'index.json' });
  const core = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(core, /## 用户/);
  assert.match(core, /建议 3000 字内/);
  assert.ok((await stat(notesDir)).isDirectory());
});

await t.test('召回节关闭模板插值（interpolate:false）', async () => {
  const recall = ctx1.sections.find((s) => s.name === 'dsh-x-memory:recall');
  assert.ok(recall, '未注册 recall section');
  assert.equal(recall.order, 60);
  assert.equal(recall.interpolate, false);
});

await t.test('空 title/content 拒绝写入', async () => {
  const out = await callTool(tools1, 'memory_write', { title: ' ', content: '' });
  assert.match(out, /保存失败/);
});

let firstId = '';
await t.test('写入记忆：id 带 6 位随机后缀，文件与索引一致', async () => {
  const out = await callTool(tools1, 'memory_write', {
    title: '{{danger}} 注入测试',
    content: '这段正文包含模板语法 {{secret}}，注入系统提示时必须被拆开。',
    tags: ['tag{{x}}', '预算'],
  });
  assert.match(out, /已保存归档记忆/);
  const m = /\[([^\]]+)\]/.exec(out);
  assert.ok(m, '返回里没有 id：' + out);
  firstId = m[1];
  assert.match(firstId, /^\d{8}-\d{6}(?:-[a-z0-9]+)*-[0-9a-f]{6}$/, 'id 缺少随机后缀：' + firstId);
  const file = await readFile(join(notesDir, firstId + '.md'), 'utf8');
  assert.match(file, /title: \{\{danger\}\} 注入测试/);
  const index = await readIndex();
  assert.ok(index.notes.some((n) => n.id === firstId));
});

await t.test('注入节里的标题/标签已 sanitize，且不含裸 {{', async () => {
  const text = await ctx1.sections[0].text();
  assert.ok(text.includes('{ {danger}} 注入测试'), '标题没有被拆开：' + text.slice(0, 400));
  assert.ok(text.includes('#tag{ {x}}'), '标签没有被拆开');
  assert.ok(!text.includes('{{danger}}'), '注入节仍含裸模板语法');
  assert.ok(!text.includes('{{secret}}'), '正文中的模板语法泄进了注入节');
});

await t.test('疑似重复默认拒写，force=true 才写入', async () => {
  const dup = await callTool(tools1, 'memory_write', {
    title: '{{danger}} 注入测试',
    content: '这段正文包含模板语法 {{secret}}，注入系统提示时必须被拆开。',
  });
  assert.match(dup, /疑似重复/);
  const forced = await callTool(tools1, 'memory_write', {
    title: '{{danger}} 注入测试',
    content: '这段正文包含模板语法 {{secret}}，注入系统提示时必须被拆开。',
    force: true,
  });
  assert.match(forced, /已保存归档记忆/);
});

await t.test('中文检索命中正文', async () => {
  const out = await callTool(tools1, 'memory_search', { query: '模板 语法' });
  assert.match(out, /【归档记忆】/);
  assert.match(out, /注入测试/);
});

await t.test('按标签过滤 list', async () => {
  const out = await callTool(tools1, 'memory_list', { tag: '预算' });
  assert.match(out, /归档记忆共 1 条/);
});

await t.test('memory_read 支持完整 id 与唯一前缀', async () => {
  const full = await callTool(tools1, 'memory_read', { id: firstId });
  assert.match(full, /模板语法/);
  const byPrefix = await callTool(tools1, 'memory_read', { id: firstId.slice(0, 12) });
  assert.match(byPrefix, /\[/);
});

await t.test('敏感内容落盘但隐藏正文、不进注入节', async () => {
  const out = await callTool(tools1, 'memory_write', {
    title: '凭据形状测试',
    content: '随便写点什么 password: hunter2hunter2 结束',
    force: true,
  });
  assert.match(out, /敏感/);
  const index = await readIndex();
  const note = index.notes.find((n) => n.title === '凭据形状测试');
  assert.ok(note && note.sensitive === true);
  const section = await ctx1.sections[0].text();
  assert.ok(!section.includes('凭据形状测试'), '敏感条目标题出现在注入节');
  const search = await callTool(tools1, 'memory_search', { query: '凭据 形状' });
  assert.match(search, /敏感内容已隐藏/);
});

await t.test('delete 先写墓碑再改索引', async () => {
  const out = await callTool(tools1, 'memory_delete', { id: firstId });
  assert.match(out, /已删除记忆/);
  const tomb = await readFile(join(notesDir, firstId + '.md'), 'utf8');
  assert.ok(tomb.startsWith('---\ndeleted: true'), '墓碑格式不对：' + tomb.slice(0, 40));
  const index = await readIndex();
  assert.ok(!index.notes.some((n) => n.id === firstId), '索引里仍有已删除条目');
  const again = await callTool(tools1, 'memory_delete', { id: firstId });
  assert.match(again, /未找到/);
});

let oldId = '';
await t.test('supersedes 标记旧条目', async () => {
  const a = await callTool(tools1, 'memory_write', { title: '旧结论', content: '这条结论将被取代。', force: true });
  oldId = /\[([^\]]+)\]/.exec(a)[1];
  const b = await callTool(tools1, 'memory_write', {
    title: '新结论', content: '新结论覆盖旧结论。', supersedes: oldId, force: true,
  });
  assert.match(b, /已标记为/);
  const oldFile = await readFile(join(notesDir, oldId + '.md'), 'utf8');
  assert.match(oldFile, /supersededBy: \d{8}-/);
  const list = await callTool(tools1, 'memory_list', {});
  assert.match(list, /已被/);
});

await t.test('核心记忆超预算时告警，注入时截断', async () => {
  const out = await callTool(tools1, 'memory_core', {
    action: 'append', section: '项目', text: '长'.repeat(4000),
  });
  assert.match(out, /已超 3000 字/);
  const section = await ctx1.sections[0].text();
  assert.match(section, /核心记忆过长已截断/);
});

await t.test('启动对账：notes/ 有、索引无 → 补录', async () => {
  await writeFile(join(notesDir, '20200101-000000-orphan.md'),
    '---\nid: 20200101-000000-orphan\ntitle: 外部新增笔记\ntags: 手工\ncreated: 2020-01-01T00:00:00.000Z\nupdated: 2020-01-01T00:00:00.000Z\n---\n\n外部正文。\n');
  const ctx2 = makeCtx();
  registerCoreMemory(ctx2.ctx, {});
  await waitFor(async () => {
    const index = await readIndex();
    return index.notes.some((n) => n.id === '20200101-000000-orphan');
  }, { label: 'orphan 补录' });
  const index = await readIndex();
  assert.ok(index.notes.some((n) => n.title === '外部新增笔记'));
});

await t.test('id 前缀歧义时拒绝读取', async () => {
  await writeFile(join(notesDir, '20200101-000000-orphan2.md'),
    '---\nid: 20200101-000000-orphan2\ntitle: 第二条外部笔记\ncreated: 2020-01-01T00:00:00.000Z\n---\n\n正文。\n');
  const ctx3 = makeCtx();
  registerCoreMemory(ctx3.ctx, {});
  await waitFor(async () => {
    const index = await readIndex();
    return index.notes.some((n) => n.id === '20200101-000000-orphan2');
  }, { label: '第二条补录' });
  const out = await callTool(ctx3.tools, 'memory_read', { id: '20200101-000000-orph' });
  assert.match(out, /id 有歧义/);
});

await t.test('启动对账：索引有、文件无 → missing，列表标记且不进注入节', async () => {
  await rm(join(notesDir, '20200101-000000-orphan2.md'));
  const ctx4 = makeCtx();
  registerCoreMemory(ctx4.ctx, {});
  await waitFor(async () => {
    const index = await readIndex();
    const note = index.notes.find((n) => n.id === '20200101-000000-orphan2');
    return note && note.missing === true;
  }, { label: 'missing 标记' });
  const list = await callTool(ctx4.tools, 'memory_list', {});
  assert.match(list, /第二条外部笔记（文件缺失）/);
  const section = await ctx4.sections[0].text();
  assert.ok(!section.includes('第二条外部笔记'), 'missing 条目仍进了注入节');
});

await t.test('索引损坏 → 读取时重建并写回合法 JSON', async () => {
  await writeFile(indexPath, '{not json');
  const list = await callTool(tools1, 'memory_list', {});
  assert.match(list, /归档记忆共/);
  const index = await readIndex();
  assert.ok(Array.isArray(index.notes));
});

await t.test('index.json.lock 被占用时写入失败，超时锁会被清理', async () => {
  const lock = indexPath + '.lock';
  await writeFile(lock, '999999');
  const blocked = await callTool(tools1, 'memory_write', {
    title: '锁测试', content: '锁占用时不应写入。', force: true,
  });
  assert.match(blocked, /索引写入被占用/);
  assert.ok(!(await noteFiles()).some((n) => n.includes('锁测试') || n.includes('lock')), '锁占用时仍写了文件');
  // 把锁改成 20 秒前的残留，下一次写入应自动清理并成功。
  const old = new Date(Date.now() - 20000);
  await utimes(lock, old, old);
  const ok = await callTool(tools1, 'memory_write', { title: '锁恢复', content: '旧锁被清理后写入成功。', force: true });
  assert.match(ok, /已保存归档记忆/);
  await assert.rejects(stat(lock));
});

await t.test('正文缓存按 mtime/size 失效', async () => {
  const saved = await callTool(tools1, 'memory_write', { title: '缓存测试', content: 'alpha 正文', force: true });
  const id = /\[([^\]]+)\]/.exec(saved)[1];
  assert.match(await callTool(tools1, 'memory_search', { query: 'alpha' }), /缓存测试/);
  const file = join(notesDir, id + '.md');
  const text = await readFile(file, 'utf8');
  await writeFile(file, text.replace('alpha 正文', 'beta 正文换了长度'));
  const hit = await callTool(tools1, 'memory_search', { query: 'beta' });
  assert.match(hit, /缓存测试/, '正文改动后缓存没有失效');
});

await t.test('persona 路由：拒绝跨源与错误 Content-Type，同源 JSON 可写', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  assert.ok(route, '未注册 persona 路由');
  const host = '127.0.0.1:2300';

  let res = fakeRes();
  await route.handler(fakeReq({ method: 'GET', headers: { host } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).presets.length > 0);

  res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST', headers: { host, origin: 'http://evil.example', 'content-type': 'application/json' }, body: '{}',
  }), res);
  assert.equal(res.statusCode, 403);

  res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST', headers: { host, origin: 'http://' + host, 'content-type': 'text/plain' }, body: '{}',
  }), res);
  assert.equal(res.statusCode, 415);

  res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST',
    headers: { host, origin: 'http://' + host, 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: true, preset: 'custom', custom: '说话简短，先给结论。' }),
  }), res);
  assert.equal(res.statusCode, 200);
  const state = readPersona();
  assert.equal(state.preset, 'custom');
  assert.match(state.custom, /先给结论/);
});

await t.test('persona 文件无 front-matter 时视为 custom 并注入', async () => {
  await writeFile(join(memoryDir, 'PERSONA.md'), '# 我的风格\n\n多用短句，直接给数字。\n');
  const state = readPersona();
  assert.equal(state.preset, 'custom');
  assert.match(state.custom, /多用短句/);
  const text = await ctx1.sections[0].text();
  assert.match(text, /## 回复风格/);
  assert.match(text, /多用短句/);
});

const result = t.finish();
await home.cleanup();
if (result.fail === 0) console.log('核心记忆自检通过。');
