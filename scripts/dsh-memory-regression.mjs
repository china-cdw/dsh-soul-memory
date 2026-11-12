// 修复项最小回归：每个 P0/P1/P2 修复至少一条断言，防止以后的改动把它们改回去。
//
// 运行：node scripts/dsh-memory-regression.mjs
import { mkdir, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, makeHome, suite } from './_testkit.mjs';
import {
  atomicWrite,
  latestSnapshot,
  memoryPath,
  safeJson,
  sliceSafe,
  snapshotMemory,
} from '../src/memory/util.js';
import { _resetGuardCache, checkGuard, guardRulesPath } from '../src/memory/guard.js';
import * as guard from '../src/memory/guard.js';
import { exitCodeOf } from '../src/lessons.js';

const home = await makeHome('dsh-mem-regress-');
const t = suite('修复项回归');

const exists = async (p) => { try { await stat(p); return true; } catch { return false; } };
const sortedDirs = async (dir) => (await readdir(dir).catch(() => [])).filter((n) => !n.startsWith('.')).sort();

await t.test('P0-2 空记忆目录快照：返回 error 且不留下空目录', async () => {
  const out = await snapshotMemory({ keep: 3 });
  assert.equal(out.skipped, false);
  assert.equal(out.copied, 0);
  assert.match(out.error, /没有可快照/);
  assert.equal(await exists(out.dir), false);
});

await t.test('P0-2 有文件时正常复制', async () => {
  await writeFile(memoryPath('MEMORY.md'), '# 核心\n', 'utf8');
  await writeFile(memoryPath('PERSONA.md'), '---\npreset: custom\n---\n', 'utf8');
  const out = await snapshotMemory({ keep: 3 });
  assert.equal(out.skipped, false);
  assert.ok(out.copied >= 2, 'copied=' + out.copied);
  assert.equal(await exists(join(out.dir, 'MEMORY.md')), true);
});

await t.test('P1-11 轮转按 mtime 而非目录名', async () => {
  const root = memoryPath('.snapshots');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  // 名字排序与 mtime 排序相反：按名字轮转就会删错。
  const oldest = 'zzz-oldest-but-name-last';
  const newest = 'aaa-newest-but-name-first';
  const middle = 'mmm-middle';
  for (const [name, days] of [[oldest, 3], [middle, 2], [newest, 1]]) {
    await mkdir(join(root, name), { recursive: true });
    // 只有完整备份才算有效快照；残缺目录会被优先清掉（见下一条断言）。
    await writeFile(join(root, name, '.complete'), 'done', 'utf8');
    const when = new Date(Date.now() - days * 86400000);
    await utimes(join(root, name), when, when);
  }
  // 一个 0.3.11 之前的旧快照（没有 .complete，但有 MEMORY.md）：它是可用备份，
  // 必须参与 keep 计数，不能当成残片删掉。
  await mkdir(join(root, 'legacy'), { recursive: true });
  await writeFile(join(root, 'legacy', 'MEMORY.md'), 'old but valid', 'utf8');
  const legacyWhen = new Date(Date.now() - 6 * 3600000);
  await utimes(join(root, 'legacy'), legacyWhen, legacyWhen);
  // 一个空壳目录：既没有完成标记也没有记忆文件，必须无条件清掉。
  await mkdir(join(root, 'empty-shell'), { recursive: true });
  const shellWhen = new Date(Date.now() - 963 * 86400000);
  await utimes(join(root, 'empty-shell'), shellWhen, shellWhen);
  await writeFile(memoryPath('CODING.md'), '# 规则\n', 'utf8');
  await snapshotMemory({ keep: 3 });
  const left = await sortedDirs(root);
  assert.equal(left.includes('empty-shell'), false, '空壳目录必须被清掉');
  assert.equal(left.includes('legacy'), true, '旧版快照要计入 keep，不能被当成残片删除');
  assert.equal(left.includes(middle), false, '最旧的完整备份应先被淘汰');
  assert.equal(left.includes(newest), true);
  assert.equal(left.includes(oldest), false);
  assert.ok(left.length <= 3, 'keep=3 时保留数不应超过 3，实际 ' + left.length);
  const latest = await latestSnapshot();
  assert.ok(latest, 'latestSnapshot 不应为空');
});

await t.test('P2 safeJson 坏输入回落', async () => {
  assert.deepEqual(safeJson('{bad', { ok: false }), { ok: false });
  assert.deepEqual(safeJson('{"a":1}'), { a: 1 });
  assert.equal(safeJson('undefined'), null);
});

await t.test('P1-5 atomicWrite 失败不留临时文件', async () => {
  const file = memoryPath('CODING.md');
  await atomicWrite(file, '# 原子\n');
  const names = await sortedDirs(memoryPath(''));
  assert.equal(names.some((n) => n.includes('.tmp-')), false);
});

await t.test('P2 guard 空数组回落默认规则', async () => {
  _resetGuardCache();
  await writeFile(guardRulesPath(), JSON.stringify({ reject: [], sensitive: [] }), 'utf8');
  _resetGuardCache();
  assert.equal(checkGuard(['AKIA', 'IOSFODNN7EXAMPLE'].join('')).kind, 'reject');
  assert.equal(checkGuard('今天写完了').kind, null);
});

await t.test('P2 maskSecrets 已从公开 API 删除', async () => {
  assert.equal('maskSecrets' in guard, false);
});

await t.test('P1-7 exitCodeOf 认 0 为成功信号', async () => {
  assert.equal(exitCodeOf('[exit code: 0]'), 0);
  assert.equal(exitCodeOf('EXIT_CODE=0'), 0);
  assert.equal(exitCodeOf('[exit code: 2]'), 2);
  assert.equal(exitCodeOf('EXIT_CODE: -1'), -1);
  assert.equal(exitCodeOf('no code here'), null);
});

await t.test('P1-12 sliceSafe 不切断代理对', async () => {
  const emoji = String.fromCodePoint(0x1f600); // 😀（代理对，length 2）
  assert.equal(emoji.length, 2);
  assert.equal(sliceSafe('A' + emoji + 'B', 2), 'A');
  assert.equal(sliceSafe(emoji, 1), '');
  const whole = 'A' + emoji + 'B';
  assert.equal(sliceSafe(whole, whole.length), whole);
  assert.equal(sliceSafe('plain', 3), 'pla');
});

await t.test('P2 package.json 发布包含 scripts/ 且 test 串起全部自检', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.ok(pkg.files.includes('scripts/'), 'files 缺 scripts/');
  const test = pkg.scripts.test || '';
  for (const name of [
    'dsh-memory-audit.mjs',
    'dsh-memory-coding-audit.mjs',
    'dsh-memory-lessons-audit.mjs',
    'lessons-replay-test.mjs',
    'dsh-memory-bridge-audit.mjs',
    'dsh-memory-regression.mjs',
  ]) assert.ok(test.includes(name), 'test 未包含 ' + name);
});


await t.test('P2 轮转不把文本 evolve.sqlite 当图谱完成', async () => {
  const root = memoryPath('.snapshots');
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const name = '2026-01-01T00-00-00';
  await mkdir(join(root, name), { recursive: true });
  await writeFile(join(root, name, '.started'), 'x', 'utf8');
  await writeFile(join(root, name, 'evolve.sqlite'), 'not a database', 'utf8');
  const old = new Date(Date.now() - 3 * 86400000);
  await utimes(join(root, name), old, old);
  await writeFile(memoryPath('MEMORY.md'), '# core\n', 'utf8');
  await snapshotMemory({ keep: 7 });
  const left = await sortedDirs(root);
  assert.equal(left.includes(name), false, '半截/文本图谱不算完成，超过 2 天应清掉');
})

await t.test('P2 单次返回受硬上限约束（limit 不能无限放大）', async () => {
  const { expandRange } = await import('../src/session-search.js');
  const events = [{ seq: 1, data: { text: 'x'.repeat(30000) } }];
  const session = { eventAt: (seq) => events.find((e) => e.seq === seq) ?? null };
  const out = expandRange(session, 1, 1, { limit: 1e9 });
  assert.equal(out.bytes <= 20000, true, 'bytes=' + out.bytes);
  assert.equal(out.truncated, true);
});

await t.test('P2 resume.offset 可以续读首条被裁剪的事件', async () => {
  const { expandRange } = await import('../src/session-search.js');
  const text = 'A'.repeat(5000);
  const events = [{ seq: 1, data: { text } }];
  const session = { eventAt: (seq) => events.find((e) => e.seq === seq) ?? null };
  const first = expandRange(session, 1, 1, { limit: 100 });
  assert.equal(Boolean(first.resume && first.resume.offset > 0), true, JSON.stringify(first.resume));
  const next = expandRange(session, first.resume.seq, first.resume.seq, { limit: 200, offset: first.resume.offset });
  assert.equal(next.bytes > 0, true);
  assert.equal(next.text.length > 0, true);
});

const result = t.finish();
process.exit(result.fail ? 1 : 0);
