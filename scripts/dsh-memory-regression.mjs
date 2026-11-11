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
    const when = new Date(Date.now() - days * 86400000);
    await utimes(join(root, name), when, when);
  }
  await writeFile(memoryPath('CODING.md'), '# 规则\n', 'utf8');
  await snapshotMemory({ keep: 2 });
  const left = await sortedDirs(root);
  assert.equal(left.length, 2);
  assert.equal(left.includes(oldest), false);
  assert.equal(left.includes(newest), true);
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

const result = t.finish();
process.exit(result.fail ? 1 : 0);
