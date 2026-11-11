// 编码规范层自检：写回不丢规则（P0）、预算截断、注入节关闭插值、项目文件来源。
//
// 运行：node scripts/dsh-memory-coding-audit.mjs
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assert, callTool, makeCtx, makeHome, suite } from './_testkit.mjs';
import { addRule, codingPath, collectRules, forgetRule, registerCodingRules } from '../src/coding.js';

const home = await makeHome('dsh-mem-coding-');
const t = suite('编码规范自检');
const codingFile = codingPath();
const projectDir = join(home.dir, 'project');

await t.test('注册 section：order 61 且 interpolate:false', async () => {
  const { ctx, sections } = makeCtx();
  registerCodingRules(ctx, { budget: 2000 });
  const section = sections.find((s) => s.name === 'dsh-x-memory:coding');
  assert.ok(section);
  assert.equal(section.order, 61);
  assert.equal(section.interpolate, false);
});

await t.test('addRule 建文件并追加，重复规则被拒绝', async () => {
  const first = await addRule('提交前先跑测试。');
  assert.equal(first.ok, true);
  const text = await readFile(codingFile, 'utf8');
  assert.match(text, /## 规则/);
  assert.match(text, /- 提交前先跑测试。/);
  const dup = await addRule('提交前先跑测试。');
  assert.equal(dup.ok, false);
  assert.match(dup.error, /已有相同规则/);
});

await t.test('P0：超过 6000 字的 CODING.md 追加规则时不丢原有规则', async () => {
  const rules = [];
  for (let i = 1; i <= 200; i++) rules.push(`- 规则 ${String(i).padStart(3, '0')}：这是一条用于撑大文件的编码约定，长度足够让文件超过读取上限。`);
  const big = '# 编码规范（全局）\n\n## 规则\n\n' + rules.join('\n') + '\n';
  assert.ok(big.length > 6000, '测试文件不够大：' + big.length);
  await writeFile(codingFile, big);

  const added = await addRule('追加后必须保留全部旧规则。');
  assert.equal(added.ok, true);

  const after = await readFile(codingFile, 'utf8');
  const kept = after.split('\n').filter((line) => /^- 规则 \d{3}：/.test(line));
  assert.equal(kept.length, 200, '写回时丢了规则，只剩 ' + kept.length + ' 条');
  assert.ok(after.includes('- 追加后必须保留全部旧规则。'));
  assert.ok(!after.includes('已截断'), '写回文件里混入了截断标记');
});

await t.test('P0：forgetRule 在超大文件上也只删目标规则', async () => {
  const res = await forgetRule('追加后必须保留全部旧规则。');
  assert.equal(res.ok, true);
  assert.equal(res.removed, 1);
  const after = await readFile(codingFile, 'utf8');
  assert.equal(after.split('\n').filter((line) => /^- 规则 \d{3}：/.test(line)).length, 200);
  assert.ok(!after.includes('追加后必须保留全部旧规则。'));
  const missing = await forgetRule('这条规则不存在。');
  assert.equal(missing.ok, false);
});

await t.test('collectRules 按预算截断并标注', async () => {
  const out = collectRules(null, { budget: 1000, globalText: '规则内容。'.repeat(1000) });
  assert.equal(out.truncated, true);
  assert.match(out.text, /已按 1000 字预算截断/);
  assert.ok(out.text.length <= 1100, '截断后仍超预算：' + out.text.length);
});

await t.test('预算过小时给出提示', async () => {
  const out = collectRules(null, { budget: 500, globalText: '一条规则。' });
  assert.match(out.text, /预算提示/);
  assert.match(out.text, /coding\.budget/);
});

await t.test('项目内 AGENTS.md / CLAUDE.md / .cursor/rules 都参与收集', async () => {
  await mkdir(join(projectDir, '.cursor', 'rules'), { recursive: true });
  await writeFile(join(projectDir, 'AGENTS.md'), '# 项目约定\n\n- 用 pnpm。\n');
  await writeFile(join(projectDir, 'CLAUDE.md'), '# Claude\n\n- 注释写中文。\n');
  await writeFile(join(projectDir, '.cursor', 'rules', 'a.mdc'), '---\ndescription: x\n---\n- 不要用 any。\n');
  // 前面的用例往全局 CODING.md 写了 200 条规则；这里显式给空全局层，
  // 否则 3000 字预算会被全局层吃光，项目文件根本轮不到（不是代码 bug）。
  const out = collectRules(projectDir, { budget: 3000, globalText: '' });
  const labels = out.files.map((f) => f.label).join('|');
  assert.match(labels, /AGENTS\.md/);
  assert.match(labels, /CLAUDE\.md/);
  assert.match(labels, /\.cursor\/rules\/a\.mdc/);
  assert.match(out.text, /用 pnpm/);
  assert.match(out.text, /不要用 any/);
});

await t.test('coding_rules 工具：add / list / show / forget 可用', async () => {
  const { ctx, tools } = makeCtx();
  registerCodingRules(ctx, { budget: 2000 });
  assert.match(await callTool(tools, 'coding_rules', { action: 'add', text: '工具写入的规则。' }), /已记入/);
  assert.match(await callTool(tools, 'coding_rules', { action: 'list' }), /工具写入的规则/);
  assert.match(await callTool(tools, 'coding_rules', { action: 'show' }), /编码规范/);
  assert.match(await callTool(tools, 'coding_rules', { action: 'forget', text: '工具写入的规则。' }), /已删除 1 条/);
  assert.match(await callTool(tools, 'coding_rules', { action: 'bogus' }), /参数错误/);
});

const result = t.finish();
await home.cleanup();
if (result.fail === 0) console.log('编码规范自检通过。');
