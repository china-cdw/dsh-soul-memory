// 踩坑层重放测试：按真实事件顺序重放一次「工具报错 → 换个命令成功」，
// 验证记录、合并、脱敏、预算与注入节缓存的表现。
//
// 运行：node scripts/lessons-replay-test.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assert, callTool, makeCtx, makeHome, suite, waitFor } from './_testkit.mjs';
import {
  buildLessonsText,
  clearLessons,
  errorFingerprint,
  lessonsPath,
  listLessons,
  mergeRows,
  registerLessons,
} from '../src/lessons.js';

await makeHome('dsh-mem-replay-');
const t = suite('踩坑重放测试');
const file = lessonsPath();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readLines = async () => (await readFile(file, 'utf8')).split('\n').filter((line) => line.trim());

const { ctx, handlers, tools, sections } = makeCtx();
registerLessons(ctx, { budget: 600 });
const section = sections.find((s) => s.name === 'dsh-x-memory:lessons');
const fire = (type, data, session = 's-replay') => handlers.get('session/event')({ id: session }, { type, data });

let n = 0;
const replay = (toolName, args, content, isError) => {
  n += 1;
  fire('tool/call', { callId: 'r' + n, name: toolName, arguments: args });
  fire('tool/result', { message: { toolCallId: 'r' + n, content, isError } });
};

await t.test('1. 初始注入节为空', async () => {
  await sleep(120);
  assert.equal(section.text(), '');
});

await t.test('2. 报错后换命令成功，注入节出现这条坑与生效做法', async () => {
  replay('ops_bash', { command: 'pnpm build --prod' }, 'vite build failed\n[exit code: 1]');
  replay('ops_bash', { command: 'pnpm build' }, 'built in 2s\n[exit code: 0]');
  const text = await waitFor(() => section.text() || false, { label: '注入节刷新' });
  assert.match(text, /踩过的坑/);
  assert.match(text, /vite build failed/);
  assert.match(text, /生效做法：pnpm build/);
});

await t.test('3. 注入节明确标注为自动记录', async () => {
  assert.match(section.text(), /自动记录/);
});

await t.test('4. 指纹把路径与长数字归一化，同类错误可合并', async () => {
  const a = errorFingerprint('ops_bash', 'C:\\work\\app\\src\\index.ts:1234 boom');
  const b = errorFingerprint('ops_bash', 'D:\\other\\main.js:999 boom');
  assert.equal(a, b);
  assert.match(a, /<path>/);
  assert.match(a, /<n>/);
});

await t.test('5. 同类错误两条记录合并计数', async () => {
  await mkdir(dirname(file), { recursive: true });
  const row = (at) => ({ fp: 'ops_bash:same', tool: 'ops_bash', error: 'same error', ok: '', count: 1, at });
  await writeFile(file, [row(1), row(2)].map((r) => JSON.stringify(r)).join('\n') + '\n');
  const merged = mergeRows(await listLessons());
  assert.equal(merged.length, 1);
  assert.equal(merged[0].count, 2);
});

await t.test('6. 敏感内容在记录前被脱敏', async () => {
  await writeFile(file, '');
  replay('ops_bash', { command: 'deploy --token abcdef123456' }, 'auth failed token=abcdef123456\n[exit code: 4]');
  replay('ops_bash', { command: 'deploy' }, '[exit code: 0]');
  const rows = await waitFor(() => listLessons().then((r) => (r.length ? r : false)), { label: '等待脱敏记录' });
  assert.ok(!rows[0].error.includes('abcdef123456'), '敏感串未被隐藏：' + rows[0].error);
});

await t.test('7. 每条坑位截到 260 字以内', async () => {
  const rows = [{ fp: 'x', tool: 'ops_bash', error: 'e'.repeat(800), ok: '', count: 1, at: Date.now() }];
  const text = buildLessonsText(rows, { budget: 5000 });
  const line = text.split('\n').find((l) => l.startsWith('- ['));
  assert.ok(line.length <= 261, '单行过长：' + line.length);
});

await t.test('8. 预算不足时截断并标注', async () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ fp: 'p' + i, tool: 'ops_bash', error: '错误' + i, ok: '', count: 1, at: Date.now() }));
  const text = buildLessonsText(rows, { budget: 300, limit: 20 });
  assert.ok(text.length <= 320, '超预算：' + text.length);
  assert.match(text, /已截断/);
});

await t.test('9. 记录总数上限 400 行', async () => {
  await sleep(200);
  const rows = Array.from({ length: 400 }, (_, i) => JSON.stringify({ fp: 'cap' + i, tool: 'ops_bash', error: 'e' + i, ok: '', count: 1, at: i }));
  await writeFile(file, rows.join('\n') + '\n');
  replay('ops_bash', { command: 'cap-cmd' }, 'boom\n[exit code: 5]');
  replay('ops_bash', { command: 'cap-cmd-2' }, '[exit code: 0]');
  await waitFor(() => readLines().then((l) => (l.length >= 400 ? l : false)), { label: '等待写入' });
  await sleep(150);
  assert.equal((await readLines()).length, 400);
});

await t.test('10. list 展示 ×N 计数', async () => {
  await writeFile(file, '');
  const rows = [
    { fp: 'ops_bash:dup', tool: 'ops_bash', error: 'dup error', ok: '', count: 1, at: 1 },
    { fp: 'ops_bash:dup', tool: 'ops_bash', error: 'dup error', ok: '', count: 1, at: 2 },
  ];
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const text = await callTool(tools, 'lessons', { action: 'list' });
  assert.match(text, /×2/);
});

await t.test('11. clear 后注入节回空', async () => {
  await callTool(tools, 'lessons', { action: 'clear' });
  await waitFor(() => clearLessons().then(() => section.text() === ''), { label: '注入节清空' });
  assert.equal(section.text(), '');
});

const result = t.finish();
process.exit(result.fail ? 1 : 0);
