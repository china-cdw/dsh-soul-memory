// 规则晋升「人批准」通道自检。
//
// 验证四件事：
// 1. propose 只把规则写进待批文件，不碰 CODING.md、不注入；
// 2. approve 之后才写进 CODING.md，并从待批里移除；
// 3. reject 只丢弃，不写 CODING.md；
// 4. 门槛文案与待批提示确实进了注入头（不是只写在注释里）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeHome, makeCtx, suite, callTool, assert } from './_testkit.mjs';
import { collectRules, codingPath, pendingPath, registerCodingRules } from '../src/coding.js';

const home = await makeHome();
const s = suite('dsh-memory-promote');
const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');
const pendingList = () => {
  const text = read(pendingPath());
  return text.trim() ? JSON.parse(text) : [];
};

try {
  const { ctx, tools } = makeCtx();
  registerCodingRules(ctx, { enabled: true, budget: 2000 });

  let firstId = '';

  await s.test('propose 只进待批，不写 CODING.md', async () => {
    const text = await callTool(tools, 'coding_rules', { action: 'propose', text: '提交前先跑相关测试', why: '避免假完成' });
    assert.match(text, /已进入待批/);
    assert.equal(read(codingPath()), '');
    assert.ok(read(pendingPath()).includes('提交前先跑相关测试'));
    firstId = pendingList()[0].id;
    assert.match(firstId, /^[0-9a-f]{8}$/);
  });

  await s.test('pending 列出内容与 id', async () => {
    const listed = await callTool(tools, 'coding_rules', { action: 'pending' });
    assert.match(listed, /待批 1 条/);
    assert.ok(listed.includes(firstId));
    assert.match(listed, /避免假完成/);
  });

  await s.test('重复 propose 幂等，不重复排队', async () => {
    const dup = await callTool(tools, 'coding_rules', { action: 'propose', text: '提交前先跑相关测试' });
    assert.match(dup, /\[err:E_DUPLICATE\]/);
    assert.equal(pendingList().length, 1);
  });

  await s.test('注入头带门槛与待批提示', () => {
    const rules = collectRules(null, { budget: 2000 });
    assert.match(rules.text, /晋升门槛/);
    assert.match(rules.text, /待批规则 1 条/);
  });

  await s.test('approve 才写进 CODING.md 并清空待批', async () => {
    const approved = await callTool(tools, 'coding_rules', { action: 'approve', ids: [firstId] });
    assert.match(approved, /已批准 1 条/);
    assert.ok(read(codingPath()).includes('提交前先跑相关测试'));
    assert.equal(pendingList().length, 0);
  });

  await s.test('批准后的规则进入注入内容', () => {
    assert.ok(collectRules(null, { budget: 2000 }).text.includes('提交前先跑相关测试'));
  });

  await s.test('新建的规则文件带晋升门槛', () => {
    assert.match(read(codingPath()), /晋升门槛/);
  });

  await s.test('已进正式规则的再 propose 会被挡住', async () => {
    const again = await callTool(tools, 'coding_rules', { action: 'propose', text: '提交前先跑相关测试' });
    assert.match(again, /\[err:E_DUPLICATE\]/);
  });

  await s.test('reject 只丢弃，不写 CODING.md', async () => {
    await callTool(tools, 'coding_rules', { action: 'propose', text: '这条不该进全局' });
    const id = pendingList()[0].id;
    const rejected = await callTool(tools, 'coding_rules', { action: 'reject', ids: [id] });
    assert.match(rejected, /已丢弃 1 条/);
    assert.ok(!read(codingPath()).includes('这条不该进全局'));
    assert.equal(pendingList().length, 0);
  });

  await s.test('用户明确要求的 add 仍然直接写入', async () => {
    const added = await callTool(tools, 'coding_rules', { action: 'add', text: '用 pnpm 不用 npm' });
    assert.match(added, /已记入/);
    assert.ok(read(codingPath()).includes('用 pnpm 不用 npm'));
  });

  await s.test('approve 缺 ids 报参数错误', async () => {
    const text = await callTool(tools, 'coding_rules', { action: 'approve' });
    assert.match(text, /\[err:E_ARG\]/);
  });

  await s.test('approve 未知 id 报找不到', async () => {
    const text = await callTool(tools, 'coding_rules', { action: 'approve', ids: ['deadbeef'] });
    assert.match(text, /\[err:E_NOT_FOUND\]/);
  });

  await s.test('空文本 propose 报参数错误', async () => {
    const text = await callTool(tools, 'coding_rules', { action: 'propose', text: '   ' });
    assert.match(text, /\[err:E_ARG\]/);
  });

  await s.test('待批文件损坏时拒绝写入，不覆盖原文件', async () => {
    mkdirSync(join(home.dir, 'memory'), { recursive: true });
    writeFileSync(pendingPath(), '{bad json', 'utf8');
    const text = await callTool(tools, 'coding_rules', { action: 'propose', text: '损坏时也不要覆盖' });
    assert.match(text, /\[err:E_IO\]/);
    assert.equal(read(pendingPath()), '{bad json');
    writeFileSync(pendingPath(), '[]', 'utf8');
  });

  await s.test('待批清空后注入头不再提示', () => {
    assert.ok(!collectRules(null, { budget: 2000 }).text.includes('待批规则 1 条'));
  });
} finally {
  await new Promise((r) => setTimeout(r, 80));
  await home.cleanup();
}

s.finish();
