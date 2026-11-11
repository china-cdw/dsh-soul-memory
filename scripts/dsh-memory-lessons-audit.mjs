// 踩坑层自检：退出码判定（0 视为成功）、文本兜底、并发安全写、列表上限、注入节。
//
// 运行：node scripts/dsh-memory-lessons-audit.mjs
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assert, callTool, makeCtx, makeHome, suite, waitFor } from './_testkit.mjs';
import {
  buildLessonsText,
  clearLessons,
  exitCodeOf,
  forgetLesson,
  lessonsPath,
  listLessons,
  registerLessons,
} from '../src/lessons.js';

await makeHome('dsh-mem-lessons-');
const t = suite('踩坑自检');
const file = lessonsPath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const fresh = async () => {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '');
};
// 先等一下，避免上一条用例队列里的写入落在清空之后，污染断言。
const reset = async () => {
  await sleep(250);
  // 清掉上一用例遗留的 pending/calls，否则新的成功会配到旧的失败上。
  handlers.get('session/event')?.({ id: 's1' }, { type: 'turn/end', data: {} });
  await fresh();
};

const { ctx, handlers, tools, sections } = makeCtx();
registerLessons(ctx, { budget: 600 });
const fire = (type, data, session = 's1') => handlers.get('session/event')({ id: session }, { type, data });

await t.test('注册 section：order 62 且 interpolate:false', async () => {
  const section = sections.find((s) => s.name === 'dsh-x-memory:lessons');
  assert.ok(section);
  assert.equal(section.order, 62);
  assert.equal(section.interpolate, false);
});

await t.test('exitCodeOf 支持三种写法，取不到返回 null', async () => {
  assert.equal(exitCodeOf('done\n[exit code: 0]'), 0);
  assert.equal(exitCodeOf('boom\n[exit code: 3]'), 3);
  assert.equal(exitCodeOf('EXIT_CODE=2'), 2);
  assert.equal(exitCodeOf('EXIT_CODE 7'), 7);
  assert.equal(exitCodeOf('[exit code: -1]'), -1);
  assert.equal(exitCodeOf('nothing here'), null);
});

await t.test('shell 退出码 0 不算失败，不写记录', async () => {
  await reset();
  fire('tool/call', { callId: 'c1', name: 'ops_bash', arguments: { command: 'echo ok' } });
  fire('tool/result', { message: { toolCallId: 'c1', content: 'ok\n[exit code: 0]' } });
  fire('tool/call', { callId: 'c1b', name: 'ops_bash', arguments: { command: 'echo ok2' } });
  fire('tool/result', { message: { toolCallId: 'c1b', content: '[exit code: 0]' } });
  await sleep(250);
  assert.equal((await listLessons()).length, 0);
});

await t.test('shell 非零退出码 + 恢复 → 记录，错误里保留退出码行', async () => {
  await reset();
  fire('tool/call', { callId: 'c2', name: 'ops_bash', arguments: { command: 'false' } });
  fire('tool/result', { message: { toolCallId: 'c2', content: '[exit code: 2]' } });
  // 只有失败、没有恢复：记录的是"坑 + 怎么绕过去"，此时不应落盘。
  await sleep(250);
  assert.equal((await listLessons()).length, 0);
  fire('tool/call', { callId: 'c2b', name: 'ops_bash', arguments: { command: 'false --retry' } });
  fire('tool/result', { message: { toolCallId: 'c2b', content: '[exit code: 0]' } });
  const rows = await waitFor(() => listLessons().then((r) => (r.length ? r : false)), { label: '记录退出码失败' });
  assert.equal(rows.length, 1);
  assert.match(rows[0].error, /exit code: 2/);
  assert.equal(rows[0].tool, 'ops_bash');
});

await t.test('失败后换命令成功 → 记下生效做法', async () => {
  await reset();
  fire('tool/call', { callId: 'c3', name: 'ops_bash', arguments: { command: 'bad-cmd --x' } });
  fire('tool/result', { message: { toolCallId: 'c3', content: 'command not found\n[exit code: 127]' } });
  fire('tool/call', { callId: 'c4', name: 'ops_bash', arguments: { command: 'bad-cmd --retry' } });
  fire('tool/result', { message: { toolCallId: 'c4', content: 'ok\n[exit code: 0]' } });
  const rows = await waitFor(() => listLessons().then((r) => (r[0]?.ok ? r : false)), { label: '记录生效做法' });
  assert.match(rows[0].ok, /bad-cmd/);
  assert.match(rows[0].error, /command not found/);
});

await t.test('失败后无关命令成功不算纠正', async () => {
  await reset();
  fire('tool/call', { callId: 'c3x', name: 'ops_bash', arguments: { command: 'ls /missing-dir' } });
  fire('tool/result', { message: { toolCallId: 'c3x', content: 'ls: cannot access\n[exit code: 2]' } });
  fire('tool/call', { callId: 'c4x', name: 'ops_bash', arguments: { command: 'echo unrelated' } });
  fire('tool/result', { message: { toolCallId: 'c4x', content: 'unrelated\n[exit code: 0]' } });
  await sleep(250);
  assert.equal((await listLessons()).length, 0);
});

await t.test('同一条命令重跑成功不算学到做法', async () => {
  await reset();
  fire('tool/call', { callId: 'c4a', name: 'ops_bash', arguments: { command: 'flaky --same' } });
  fire('tool/result', { message: { toolCallId: 'c4a', content: '[exit code: 9]' } });
  fire('tool/call', { callId: 'c4b', name: 'ops_bash', arguments: { command: 'flaky --same' } });
  fire('tool/result', { message: { toolCallId: 'c4b', content: '[exit code: 0]' } });
  await sleep(250);
  assert.equal((await listLessons()).length, 0);
});

await t.test('isError 结构化失败即使正文没关键词也记录', async () => {
  await reset();
  fire('tool/call', { callId: 'c5', name: 'read', arguments: { path: 'a.txt' } });
  fire('tool/result', { message: { toolCallId: 'c5', isError: true, content: 'boom' } });
  fire('tool/call', { callId: 'c5b', name: 'read', arguments: { path: 'b.txt' } });
  fire('tool/result', { message: { toolCallId: 'c5b', content: 'ok' } });
  const rows = await waitFor(() => listLessons().then((r) => (r.length ? r : false)), { label: '记录 isError' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].tool, 'read');
});

await t.test('非 shell 工具正文里的 error 字样不算失败', async () => {
  await reset();
  fire('tool/call', { callId: 'c6', name: 'read', arguments: { path: 'log.txt' } });
  fire('tool/result', { message: { toolCallId: 'c6', content: 'error: this is log content' } });
  fire('tool/call', { callId: 'c6b', name: 'read', arguments: { path: 'log2.txt' } });
  fire('tool/result', { message: { toolCallId: 'c6b', content: 'ok' } });
  await sleep(250);
  assert.equal((await listLessons()).length, 0);
});

await t.test('grep 退出码 1（无匹配）视为正常', async () => {
  await reset();
  fire('tool/call', { callId: 'c7', name: 'ops_bash', arguments: { command: 'grep -n foo a.txt' } });
  fire('tool/result', { message: { toolCallId: 'c7', content: 'no match\n[exit code: 1]' } });
  fire('tool/call', { callId: 'c7b', name: 'ops_bash', arguments: { command: 'ls' } });
  fire('tool/result', { message: { toolCallId: 'c7b', content: '[exit code: 0]' } });
  await sleep(250);
  assert.equal((await listLessons()).length, 0);
});

await t.test('list 默认只显示 50 类，其余提示 limit', async () => {
  await reset();
  const rows = [];
  for (let i = 0; i < 60; i += 1) {
    rows.push(JSON.stringify({ fp: 'fp' + i, tool: 'ops_bash', error: 'err' + i, ok: '', count: 1, at: Date.now() - i }));
  }
  await writeFile(file, rows.join('\n') + '\n');
  const text = await callTool(tools, 'lessons', { action: 'list' });
  assert.match(text, /共 60 类/);
  assert.match(text, /还有 10 类未显示/);
  assert.equal((text.match(/fp: fp\d+/g) || []).length, 50);
  const limited = await callTool(tools, 'lessons', { action: 'list', limit: 100 });
  assert.ok(!limited.includes('还有'), 'limit 足够时不应出现未显示提示');
  assert.equal((limited.match(/fp: fp\d+/g) || []).length, 60);
});

await t.test('forget 按指纹前缀删除，clear 清空', async () => {
  await reset();
  const rows = [];
  for (let i = 0; i < 5; i += 1) {
    rows.push(JSON.stringify({ fp: 'abc' + i, tool: 'ops_bash', error: 'e' + i, ok: '', count: 1, at: Date.now() }));
  }
  await writeFile(file, rows.join('\n') + '\n');
  const one = await forgetLesson('abc3');
  assert.equal(one.removed, 1);
  assert.equal((await listLessons()).length, 4);
  const cleared = await clearLessons();
  assert.equal(cleared.removed, 4);
  assert.equal((await listLessons()).length, 0);
  assert.equal((await clearLessons()).removed, 0);
});

await t.test('buildLessonsText 超预算时截断并标注', async () => {
  const rows = Array.from({ length: 30 }, (_, i) => ({ fp: 'f' + i, tool: 'ops_bash', error: '错误' + i + 'x'.repeat(40), ok: '', count: 1, at: Date.now() }));
  const text = buildLessonsText(rows, { budget: 600, limit: 30 });
  assert.ok(text.length <= 620, '截断后仍超预算：' + text.length);
  assert.match(text, /已截断/);
});

const result = t.finish();
process.exit(result.fail ? 1 : 0);
