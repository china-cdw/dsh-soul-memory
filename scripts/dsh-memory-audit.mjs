// 核心记忆层自检：注册、写入/查重/检索/删除、注入节、索引对账、锁、persona 路由。
//
// 运行：node scripts/dsh-memory-audit.mjs
// 环境：临时 DSH_HOME（不会碰真实记忆）。
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { assert, callTool, makeCtx, makeHome, suite, waitFor } from './_testkit.mjs';
import { registerCoreMemory } from '../src/core-memory.js';
import { latestSnapshot, snapshotGraph, snapshotMemory } from '../src/memory/util.js';
import { readPersona } from '../src/persona.js';
import { expandRange } from '../src/session-search.js';

// 锁测试要快：默认等待 35s，这里压到 300ms（withIndexLock 每次调用时读取）。
process.env.DSH_X_MEMORY_LOCK_WAIT_MS = '300';
process.env.DSH_X_MEMORY_LOCK_STALE_MS = '500';

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

await t.test('分节正文里的 ## 标题不切结构，且写入时降级为 ###', async () => {
  const out = await callTool(tools1, 'memory_core', {
    action: 'append', section: '环境', text: '端口说明\n## 端口\n2300',
  });
  assert.match(out, /已追加核心记忆分节「环境」/);
  const raw = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(raw, /### 端口/);
  assert.ok(!/^## 端口/m.test(raw), '正文里的 ## 被当成了分节');
  const env = (raw.split('## 环境')[1] || '').split('\n## ')[0];
  assert.match(env, /2300/, '环境分节后半段丢失');
  // 再替换一次，确认结构没被切坏
  const replaced = await callTool(tools1, 'memory_core', { action: 'replace', section: '环境', text: '环境已重写' });
  assert.match(replaced, /已替换核心记忆分节「环境」/);
  const after = await readFile(join(memoryDir, 'MEMORY.md'), 'utf8');
  assert.match(after, /## 环境\n环境已重写/);
  assert.ok(!/2300/.test(after), '旧环境正文未清掉');
});

await t.test('非法分节名被拒绝', async () => {
  const out = await callTool(tools1, 'memory_core', { action: 'append', section: '随便什么', text: 'x' });
  assert.match(out, /分节名必须是/);
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
  // 用「仍活着」的锁测占用：stale 拉长到 60s，等待 300ms 必须报占用而不是把锁当过期删掉。
  process.env.DSH_X_MEMORY_LOCK_STALE_MS = '60000';
  await writeFile(lock, '999999');
  const blocked = await callTool(tools1, 'memory_write', {
    title: '锁测试', content: '锁占用时不应写入。', force: true,
  });
  assert.match(blocked, /索引写入被占用/);
  assert.ok(!(await noteFiles()).some((n) => n.includes('锁测试') || n.includes('lock')), '锁占用时仍写了文件');
  // 把锁改成 20 秒前的残留，下一次写入应自动清理并成功。
  process.env.DSH_X_MEMORY_LOCK_STALE_MS = '500';
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
  await route.handler(fakeReq({ method: 'GET', headers: { host, 'x-dsh-x-memory': '1' } }), res);
  assert.equal(res.statusCode, 200);
  assert.ok(JSON.parse(res.body).presets.length > 0);

  res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST', headers: { host, origin: 'http://evil.example', 'content-type': 'application/json', 'x-dsh-x-memory': '1' }, body: '{}',
  }), res);
  assert.equal(res.statusCode, 403);

  res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST', headers: { host, origin: 'http://' + host, 'content-type': 'text/plain', 'x-dsh-x-memory': '1' }, body: '{}',
  }), res);
  assert.equal(res.statusCode, 415);

  res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST',
    headers: { host, origin: 'http://' + host, 'content-type': 'application/json', 'x-dsh-x-memory': '1' },
    body: JSON.stringify({ enabled: true, preset: 'custom', custom: '说话简短，先给结论。' }),
  }), res);
  assert.equal(res.statusCode, 200);
  const state = readPersona();
  assert.equal(state.preset, 'custom');
  assert.match(state.custom, /先给结论/);
});

await t.test('persona 路由：缺少 X-DSH-X-Memory 头时拒绝', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({
    method: 'POST', headers: { host: '127.0.0.1:2300', origin: 'http://127.0.0.1:2300', 'content-type': 'application/json' }, body: '{}',
  }), res);
  assert.equal(res.statusCode, 403);
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

await t.test('persona 路由拒绝非本机 Host（DNS rebinding）', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'GET', headers: { host: 'evil.example' } }), res);
  assert.equal(res.statusCode, 403);
});

await t.test('memory_read 截断不会把代码围栏切成半个', async () => {
  const fence = '```';
  const long = fence + '\n' + 'x'.repeat(7900) + '\n' + fence + '\n' + 'y'.repeat(300);
  const saved = await callTool(tools1, 'memory_write', { title: '围栏截断', content: long, force: true });
  const id = /\[([^\]]+)\]/.exec(saved)[1];
  const out = await callTool(tools1, 'memory_read', { id });
  assert.match(out, /内容过长已截断/);
  assert.equal((out.match(/^```/gm) || []).length % 2, 0, '截断后围栏不平衡');
});

await t.test('失败结果带机器可读 [err:CODE] 后缀', async () => {
  assert.match(await callTool(tools1, 'memory_read', {}), /\[err:E_ARG\]/);
  assert.match(await callTool(tools1, 'memory_write', { title: '', content: 'x' }), /\[err:E_ARG\]/);
  assert.match(await callTool(tools1, 'memory_read', { id: 'not-a-real-id-xyz' }), /\[err:E_NOT_FOUND\]/);
});

await t.test('persona 路由：非 GET/POST 返回 405 并带 Allow', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'PUT', headers: { host: '127.0.0.1:2300', 'x-dsh-x-memory': '1', 'content-type': 'application/json' }, body: '{}' }), res);
  assert.equal(res.statusCode, 405);
  assert.match(String(res.headers.allow || ''), /GET/);
});

await t.test('persona 路由：空 patch 返回 204 且不落盘', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'POST', headers: { host: '127.0.0.1:2300', origin: 'http://127.0.0.1:2300', 'content-type': 'application/json', 'x-dsh-x-memory': '1' }, body: '{}' }), res);
  assert.equal(res.statusCode, 204);
});

await t.test('persona 路由：GET 响应禁缓存', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'GET', headers: { host: '127.0.0.1:2300', 'x-dsh-x-memory': '1' } }), res);
  assert.equal(res.statusCode, 200);
  assert.equal(String(res.headers['cache-control'] || '').toLowerCase(), 'no-store');
});

await t.test('四反引号围栏内截断补关闭围栏而不是删内容', async () => {
  const fence = '`'.repeat(4);
  const long = fence + '\n' + 'q'.repeat(7900) + '\n' + fence + '\n' + 'z'.repeat(300);
  const saved = await callTool(tools1, 'memory_write', { title: '四反引号围栏', content: long, force: true });
  const id = /\[([^\]]+)\]/.exec(saved)[1];
  const out = await callTool(tools1, 'memory_read', { id });
  assert.match(out, /内容过长已截断/);
  assert.ok(out.includes('q'.repeat(100)), '截断把正文整段删了');
  assert.equal((out.match(/^`{4}/gm) || []).length % 2, 0, '四反引号围栏不平衡');
});

await t.test('重复写入带 E_DUPLICATE 错误码', async () => {
  await callTool(tools1, 'memory_write', { title: '重复码测试', content: '唯一串 zzz-dup-code-038 重复内容。', force: true });
  const second = await callTool(tools1, 'memory_write', { title: '重复码测试', content: '唯一串 zzz-dup-code-038 重复内容。' });
  assert.match(second, /\[err:E_DUPLICATE\]/);
});

await t.test('取代旧记忆时保留未知 front-matter 字段', async () => {
  const saved = await callTool(tools1, 'memory_write', { title: '取代保留字段', content: '旧结论 A。', force: true });
  const oldId = /\[([^\]]+)\]/.exec(saved)[1];
  const file = join(notesDir, oldId + '.md');
  const text = await readFile(file, 'utf8');
  // 模拟外部工具写入的未知字段：取代时不能被重新序列化丢掉。
  await writeFile(file, text.replace(/\nupdated:/, '\nowner: alice\nupdated:'));
  const next = await callTool(tools1, 'memory_write', {
    title: '取代保留字段-新', content: '新结论 B。', force: true, supersedes: oldId,
  });
  assert.match(next, /已标记为「已被/);
  const after = await readFile(file, 'utf8');
  assert.match(after, /owner: alice/);
  assert.match(after, /supersededBy:/);
});

await t.test('snapshotGraph 用 VACUUM INTO 把图谱库写进当天快照', async () => {
  const written = [];
  const fakeDb = {
    exec(sql) {
      const m = /VACUUM INTO '([^']+)'/.exec(sql);
      if (!m) throw new Error('unexpected sql: ' + sql);
      writeFileSync(m[1], 'sqlite-bytes');
      written.push(m[1]);
    },
  };
  const res = await snapshotGraph(fakeDb);
  assert.equal(res.skipped, false);
  assert.equal(written.length, 1);
  // 0.3.15 起先写 .tmp-<pid> 再 rename；检查最终文件而不是中间路径。
  assert.match(written[0], /\.snapshots[\\/][^\\/]+[\\/]evolve\.sqlite\.tmp-\d+$/);
  assert.equal(await readFile(join(res.dir, 'evolve.sqlite'), 'utf8'), 'sqlite-bytes');
});

await t.test('memory_read 认 [id] 方括号与 .md 后缀（list 打印的格式可直接回读）', async () => {
  const saved = await callTool(tools1, 'memory_write', { title: '方括号读取', content: 'bracket ref body', force: true });
  const id = /\[([^\]]+)\]/.exec(saved)[1];
  assert.match(await callTool(tools1, 'memory_read', { id: '[' + id + ']' }), /方括号读取/);
  assert.match(await callTool(tools1, 'memory_read', { id: id + '.md' }), /方括号读取/);
});

await t.test('快照以 .complete 标记为准：图谱先建当天目录不会让文件快照被跳过', async () => {
  const snaps = join(memoryDir, '.snapshots');
  const today = new Date().toISOString().slice(0, 10);
  for (const name of await readdir(snaps)) {
    await rm(join(snaps, name, '.complete'), { force: true }).catch(() => {});
  }
  const graphFirst = join(snaps, today + 'T00-00-00');
  await mkdir(graphFirst, { recursive: true });
  await writeFile(join(graphFirst, 'evolve.sqlite'), 'x');
  const r1 = await snapshotMemory();
  assert.equal(r1.skipped, false, '当天目录已存在但无完成标记时不应跳过');
  await stat(join(r1.dir, '.complete'));
  const r2 = await snapshotMemory();
  assert.equal(r2.skipped, true, '有完成标记后当天应跳过');
});

await t.test("memory_delete 的空引用（'[]'）不会删掉任何记忆", async () => {
  const before = (await readIndex()).notes.length;
  const out = await callTool(tools1, 'memory_delete', { id: '[]' });
  assert.match(out, /E_ARG/);
  assert.equal((await readIndex()).notes.length, before);
});

await t.test('当天已有图谱快照、copied=0 时不会删掉 evolve.sqlite', async () => {
  const savedHome = process.env.DSH_HOME;
  const other = await makeHome('dsh-mem-snap-');
  process.env.DSH_HOME = other.dir;
  try {
    const snaps = join(other.dir, 'memory', '.snapshots');
    const today = new Date().toISOString().slice(0, 10);
    const dir = join(snaps, today + 'T00-00-02');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'evolve.sqlite'), 'graph');
    const r = await snapshotMemory();
    assert.equal(r.copied, 0);
    assert.equal(await readFile(join(dir, 'evolve.sqlite'), 'utf8'), 'graph');
    assert.equal(await stat(join(dir, '.complete')).then(() => true, () => false), false);
  } finally {
    process.env.DSH_HOME = savedHome;
    await other.cleanup();
  }
});
await t.test('memory_read 认 [id].md 组合形式（归一化顺序）', async () => {
  const saved = await callTool(tools1, 'memory_write', { title: '组合引用', content: 'combo ref body', force: true });
  const id = /\[([^\]]+)\]/.exec(saved)[1];
  assert.match(await callTool(tools1, 'memory_read', { id: '[' + id + '].md' }), /组合引用/);
});

await t.test('persona 路由：preset 空串返回 400 且不落盘', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const before = readPersona();
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'POST', headers: { host: '127.0.0.1:2300', origin: 'http://127.0.0.1:2300', 'content-type': 'application/json', 'x-dsh-x-memory': '1' }, body: JSON.stringify({ preset: '' }) }), res);
  assert.equal(res.statusCode, 400);
  assert.equal(readPersona().preset, before.preset);
});

await t.test('persona 路由：未知字段返回 400', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'POST', headers: { host: '127.0.0.1:2300', origin: 'http://127.0.0.1:2300', 'content-type': 'application/json', 'x-dsh-x-memory': '1' }, body: JSON.stringify({ foo: 1 }) }), res);
  assert.equal(res.statusCode, 400);
});
await t.test('persona 路由：坏 JSON 返回 400 而不是 500', async () => {
  const route = ctx1.routes.find((r) => r.path === '/dsh-x-memory/persona');
  const res = fakeRes();
  await route.handler(fakeReq({ method: 'POST', headers: { host: '127.0.0.1:2300', origin: 'http://127.0.0.1:2300', 'content-type': 'application/json', 'x-dsh-x-memory': '1' }, body: '{not json' }), res);
  assert.equal(res.statusCode, 400);
  assert.ok(!/Error/.test(String(res.body || '')), '不应回显异常');
});
await t.test('persona 超长自定义正文在 disable 后不被截断', async () => {
  const big = 'x'.repeat(6000);
  const personaPath = join(memoryDir, 'PERSONA.md');
  const raw = ['---', 'enabled: true', 'preset: custom', "updated: '2026-01-01T00:00:00.000Z'", '---', '', '<!-- custom -->', big, ''].join('\n');
  await writeFile(personaPath, raw, 'utf8');
  const before = await readPersona();
  assert.equal(before.custom.length, 6000);
  await callTool(tools1, 'persona', { action: 'disable' });
  const after = await readPersona();
  assert.equal(after.custom.length, 6000, '停用风格不得截断用户正文');
});

await t.test('soul_expand 单条大事件保留部分内容且 to 前进', async () => {
  const long = 'y'.repeat(5000);
  const session = { seq: 2, eventAt: (n) => n === 1 ? { data: { text: long } } : n === 2 ? { data: { text: 'short tail' } } : null };
  const out = expandRange(session, 1, 2, { limit: 2000 });
  assert.ok(out.text.length > 0, '不能返回空内容');
  assert.equal(out.to, 1);
  assert.equal(out.truncated, true);
  assert.ok(String(out.note || '').includes('裁剪'));
});

await t.test('persona 工具：6000 字旧正文仍可切预设（继承值不参与长度校验）', async () => {
  const personaFile = join(process.env.DSH_HOME, 'memory', 'PERSONA.md');
  await writeFile(personaFile, '---\nenabled: true\npreset: custom\n---\n' + '长'.repeat(6000), 'utf8');
  const out = await callTool(tools1, 'persona', { action: 'set', preset: 'concise' });
  assert.match(out, /已切换回复风格/);
  const state = readPersona();
  assert.equal(state.preset, 'concise');
  assert.equal(state.custom.length, 6000);
});

await t.test('soul_expand：尾部没有事件不算截断', async () => {
  const fake = { eventAt: (seq) => (seq <= 2 ? { type: 'user/message', data: { content: '事件' + seq } } : null) };
  const out = expandRange(fake, 3, 9, { limit: 200 });
  assert.equal(out.events, 0);
  assert.equal(out.truncated, false);
  // 区间已扫完、没有可读事件：to 落到 end，避免客户端反复重试同一段。
  assert.equal(out.to, 9);
});

await t.test('soul_expand：单条超预算时裁剪、to 前进且 note 说明', async () => {
  const fake = { eventAt: (seq) => (seq === 1 ? { type: 'user/message', data: { content: 'x'.repeat(5000) } } : null) };
  const out = expandRange(fake, 1, 3, { limit: 500 });
  assert.equal(out.to, 1);
  assert.equal(out.truncated, true);
  assert.ok(out.bytes <= 500, 'bytes=' + out.bytes);
  assert.match(out.note || '', /首条事件超出预算/);
});


await t.test('latestSnapshot 跳过只有 .started 的在途残片', async () => {
  const snap = join(process.env.DSH_HOME, 'memory', '.snapshots');
  await rm(snap, { recursive: true, force: true });
  await mkdir(join(snap, '2026-01-01T00-00-00'), { recursive: true });
  await writeFile(join(snap, '2026-01-01T00-00-00', 'MEMORY.md'), '# old\n');
  await writeFile(join(snap, '2026-01-01T00-00-00', '.started'), new Date().toISOString());
  await mkdir(join(snap, '2026-01-02T00-00-00'), { recursive: true });
  await writeFile(join(snap, '2026-01-02T00-00-00', 'MEMORY.md'), '# ok\n');
  await writeFile(join(snap, '2026-01-02T00-00-00', '.complete'), '2026-01-02T00:00:00.000Z');
  const latest = await latestSnapshot();
  assert.equal(latest.name, '2026-01-02T00-00-00');
});

await t.test('persona set 不会把停用状态悄悄改回启用', async () => {
  await writeFile(join(process.env.DSH_HOME, 'memory', 'PERSONA.md'), '---\nenabled: false\npreset: default\nupdated: 2026-01-01\n---\n');
  const out = await callTool(tools1, 'persona', { action: 'set', preset: 'warm' });
  // 0.3.16：停用状态下切预设不再谎报「已切换」，文案必须如实说明仍停用。
  assert.match(String(out), /仍处于停用状态/);
  assert.doesNotMatch(String(out), /已切换/);
  assert.equal(readPersona().enabled, false);
  assert.equal(readPersona().preset, 'warm');
});

await t.test('expandRange 极小预算仍有进展且不切断 emoji', async () => {
  const emoji = String.fromCodePoint(0x1f600);
  const fake = { eventAt: (seq) => (seq === 1 ? { type: 'user/message', data: { content: emoji + '中文正文' } } : null) };
  const out = expandRange(fake, 1, 1, { limit: 4 });
  assert.ok(out.text.length > 0, '极小预算也要返回内容');
  assert.ok(out.to >= 1, 'to 必须前进');
  const last = out.text.charCodeAt(out.text.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), '不能以孤立高代理项结尾');
});

await t.test('persona set enabled=true 会真正启用并回报已切换', async () => {
  const personaFile = join(process.env.DSH_HOME, 'memory', 'PERSONA.md');
  await writeFile(personaFile, '---\nenabled: false\npreset: default\n---\n', 'utf8');
  const out = await callTool(tools1, 'persona', { action: 'set', preset: 'warm', enabled: true });
  assert.match(String(out), /已切换/);
  assert.equal(readPersona().enabled, true);
});

await t.test('snapshotMemory 轮转不会删掉图谱快照目录', async () => {
  const snap = join(process.env.DSH_HOME, 'memory', '.snapshots');
  await rm(snap, { recursive: true, force: true });
  const old = Date.now() / 1000 - 86400 * 3;
  for (const [name, age] of [['2025-01-01T00-00-00', 0], ['2025-01-02T00-00-00', 1], ['2025-01-03T00-00-00', 2]]) {
    const dir = join(snap, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'MEMORY.md'), '# ' + name + '\n', 'utf8');
    await writeFile(join(dir, '.complete'), new Date().toISOString(), 'utf8');
    await utimes(dir, old + age * 3600, old + age * 3600);
  }
  const graphDir = join(snap, '2025-01-04T00-00-00');
  await mkdir(graphDir, { recursive: true });
  await writeFile(join(graphDir, 'evolve.sqlite'), 'sqlite-placeholder', 'utf8');
  await writeFile(join(graphDir, '.started'), new Date().toISOString(), 'utf8');
  await utimes(graphDir, Date.now() / 1000, Date.now() / 1000);
  await snapshotMemory({ keep: 3 });
  const kept = await stat(join(graphDir, 'evolve.sqlite'));
  assert.ok(kept.size > 0, '图谱快照不能被轮转删掉');
});

const result = t.finish();
await home.cleanup();
if (result.fail === 0) console.log('核心记忆自检通过。');
