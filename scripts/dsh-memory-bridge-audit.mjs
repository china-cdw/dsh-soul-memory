// 桥接层自检：billion-context 会话摘要的读取、筛选、缓存失效、预算与检索。
//
// 运行：node scripts/dsh-memory-bridge-audit.mjs
import { mkdir, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, makeHome, suite } from './_testkit.mjs';
import { biliSessionsDir, biliStatus, searchBili } from '../src/memory/bili.js';

const home = await makeHome('dsh-mem-bridge-');
const t = suite('桥接自检');
const dir = join(home.dir, 'sessions');
await mkdir(dir, { recursive: true });

const block = (over = {}) => ({
  blockId: 'b1',
  tier: 2,
  topic: '部署脚本',
  summary: '把部署脚本改成幂等，先检查再创建目录。',
  compressedTokens: 120,
  createdAt: 1000,
  ...over,
});

const sessionFile = (id, blocks, savedAt = 1) => ({ id, savedAt, payload: { state: { blocks } } });

async function put(name, doc, seconds) {
  const file = join(dir, name);
  await writeFile(file, JSON.stringify(doc), 'utf8');
  const when = new Date(Date.now() - seconds * 1000);
  await utimes(file, when, when);
  return file;
}

const opts = { sessionsDir: dir };

await t.test('1. 空目录：不报错，found=false', async () => {
  const status = await biliStatus({ ...opts, sessionsDir: join(home.dir, 'none') });
  assert.equal(status.found, false);
  assert.equal(status.sessions, 0);
  assert.equal(status.blocks, 0);
  assert.equal(status.chars, 0);
  assert.equal(status.latest, null);
  const empty = await biliStatus({ ...opts, sessionsDir: join(home.dir, 'none') });
  assert.equal(empty.found, false);
});

await t.test('2. 单个会话两个有效块', async () => {
  await put('s1.json', sessionFile('s1', [
    block({ blockId: 'b1', summary: '第一条摘要', createdAt: 1000 }),
    block({ blockId: 'b2', summary: '第二条摘要', createdAt: 2000 }),
  ]), 10);
  const status = await biliStatus(opts);
  assert.equal(status.found, true);
  assert.equal(status.sessions, 1);
  assert.equal(status.blocks, 2);
  assert.equal(status.chars, '第一条摘要'.length + '第二条摘要'.length);
});

await t.test('3. active:false 与空摘要被跳过', async () => {
  await put('s2.json', sessionFile('s2', [
    block({ blockId: 'off', active: false }),
    block({ blockId: 'blank', summary: '   ' }),
    block({ blockId: 'on', summary: '保留这一条', topic: '' }),
  ]), 9);
  const status = await biliStatus(opts);
  assert.equal(status.sessions, 2);
  assert.equal(status.blocks, 3);
});

await t.test('4. 命中主题：返回前缀与条数', async () => {
  const out = await searchBili('部署脚本', opts);
  assert.equal(out.count, 2);
  assert.match(out.text, /^【历史会话摘要（billion-context，只读）】/);
  assert.match(out.text, /部署脚本/);
});

await t.test('5. 中文按 bigram 命中（主题与摘要分开也命中）', async () => {
  await put('s3.json', sessionFile('s3', [block({ blockId: 'cn', topic: '模板', summary: '语法要写成 {{name}}' })]), 8);
  const out = await searchBili('模板语法', opts);
  assert.ok(out.count >= 1, '中文 bigram 未命中');
  assert.match(out.text, /模板/);
});

await t.test('6. 无命中返回空串与 0', async () => {
  const out = await searchBili('完全不存在的话题xyz', opts);
  assert.equal(out.count, 0);
  assert.equal(out.text, '');
});

await t.test('7. 空查询不读盘', async () => {
  assert.deepEqual(await searchBili('   ', opts), { text: '', count: 0 });
});

await t.test('8. maxSessions 默认 4，按 mtime 取最近', async () => {
  for (let i = 0; i < 6; i += 1) {
    await put('many' + i + '.json', sessionFile('many' + i, [block({ blockId: 'x' + i, summary: '会话' + i, topic: '批量' + i })]), 60 - i);
  }
  const status = await biliStatus(opts);
  assert.equal(status.sessions, 4);
  const all = await biliStatus({ ...opts, maxSessions: 50 });
  assert.ok(all.sessions >= 9, 'maxSessions=50 应看到全部会话，实际 ' + all.sessions);
});

await t.test('9. 每个会话最多取 maxBlocksPerSession 条', async () => {
  await put('deep.json', sessionFile('deep', Array.from({ length: 8 }, (_, i) => block({ blockId: 'd' + i, summary: '块' + i, createdAt: i }))), 1);
  const status = await biliStatus({ ...opts, maxSessions: 1, maxBlocksPerSession: 5 });
  assert.equal(status.sessions, 1);
  assert.equal(status.blocks, 5);
});

await t.test('10. maxChars 预算截断', async () => {
  await put('long.json', sessionFile('long', [block({ blockId: 'L', topic: '长文', summary: '细节'.repeat(2000) })]), 0.5);
  const out = await searchBili('长文', { ...opts, maxSessions: 1, maxChars: 200 });
  assert.ok(out.text.length <= 320, '超预算：' + out.text.length);
  assert.ok(out.text.length > 0);
});

await t.test('11. 毫秒级 mtime 变化使缓存失效', async () => {
  const file = join(dir, 'cache.json');
  await writeFile(file, JSON.stringify(sessionFile('cache', [block({ blockId: 'c1', topic: '缓存', summary: '旧甲' })])), 'utf8');
  assert.equal((await searchBili('旧甲', { ...opts, maxSessions: 1 })).count, 1);
  await new Promise((r) => setTimeout(r, 15));
  await writeFile(file, JSON.stringify(sessionFile('cache', [block({ blockId: 'c1', topic: '缓存', summary: '新乙' })])), 'utf8');
  assert.equal((await searchBili('新乙', { ...opts, maxSessions: 1 })).count, 1);
  assert.equal((await searchBili('旧甲', { ...opts, maxSessions: 1 })).count, 0);
});

await t.test('12. 坏 JSON 文件被跳过，不影响其它会话', async () => {
  await writeFile(join(dir, 'broken.json'), '{not json', 'utf8');
  const status = await biliStatus({ ...opts, maxSessions: 50 });
  assert.ok(status.sessions >= 1);
});

await t.test('13. 超过缓存容量（32 个文件）后仍能读到最新内容', async () => {
  for (let i = 0; i < 40; i += 1) {
    await put('lru' + String(i).padStart(2, '0') + '.json', sessionFile('lru' + i, [block({ blockId: 'k', topic: '容量', summary: '容量' + i })]), 200 + i);
  }
  const first = await biliStatus({ ...opts, maxSessions: 50 });
  assert.ok(first.sessions >= 40, '应读全 40 个会话，实际 ' + first.sessions);
  const target = join(dir, 'lru00.json');
  await new Promise((r) => setTimeout(r, 15));
  await writeFile(target, JSON.stringify(sessionFile('lru0', [block({ blockId: 'k', topic: '容量', summary: '被淘汰后重读' })])), 'utf8');
  assert.equal((await searchBili('被淘汰后重读', { ...opts, maxSessions: 50 })).count, 1);
});

await t.test('14. sessionsDir 优先级：显式参数 > 环境变量', async () => {
  const alt = join(home.dir, 'alt');
  await mkdir(alt, { recursive: true });
  process.env.BILI_SESSIONS_DIR = alt;
  assert.equal(biliSessionsDir(), alt);
  assert.equal(biliSessionsDir(dir), dir);
  delete process.env.BILI_SESSIONS_DIR;
});

const result = t.finish();
process.exit(result.fail ? 1 : 0);
