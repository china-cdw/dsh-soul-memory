// 评审 brief 自检：只读边界、输出格式、轮次上限、默认占位。
//
// 运行：node scripts/dsh-review-brief-audit.mjs
import { assert, callTool, makeCtx, suite } from './_testkit.mjs';
import { MAX_ROUNDS, registerReview } from '../src/review.js';

const t = suite('评审 brief');
const { ctx, tools } = makeCtx();
registerReview(ctx);

await t.test('注册 review_brief 工具', () => {
  assert.ok(tools.get('review_brief'), '工具未注册');
});

await t.test('写死只读边界与输出格式', async () => {
  const text = await callTool(tools, 'review_brief', { goal: '把部署脚本的守卫补上' });
  assert.ok(text.includes('只读评审员'), '缺少只读评审员身份');
  assert.ok(text.includes('不要编辑/新建/删除文件'), '缺少禁改文件约束');
  assert.ok(text.includes('不要跑会写盘的命令'), '缺少禁写盘约束');
  assert.ok(text.includes('VERDICT: APPROVE 或 CHANGES'), '缺少裁决格式');
  assert.ok(text.includes('SCORE: x/10'), '缺少评分格式');
  assert.ok(text.includes('文件:行号'), '发现必须落到 文件:行号');
  assert.ok(text.includes('都不算通过'), '超时/报错不能算通过');
  assert.ok(text.includes('把部署脚本的守卫补上'), '目标没进 brief');
});

await t.test('没填的字段用占位说明，不瞎编', async () => {
  const text = await callTool(tools, 'review_brief', {});
  assert.ok(text.includes('（未填：默认只评这次改动'), '范围外占位缺失');
  assert.ok(text.includes('（未填：列出你实际跑过的检查'), '检查结果占位缺失');
  assert.ok(text.includes('（未填：一句话写清这次改动要达成什么'), '目标占位缺失');
});

await t.test('轮次到线就提示交人裁决', async () => {
  const first = await callTool(tools, 'review_brief', { round: 1 });
  assert.ok(first.includes('如果上一轮的意见已经被改掉'), '首轮应提示逐条确认');
  assert.ok(!first.includes('已经是最后一轮'), '首轮不该提示收尾');
  const last = await callTool(tools, 'review_brief', { round: MAX_ROUNDS });
  assert.ok(last.includes('已经是最后一轮'), '到线未提示交人裁决');
  assert.ok(last.includes('最多 ' + MAX_ROUNDS + ' 轮'), '轮次上限没写进去');
});

await t.test('传入的仓库、diff、检查结果原样带上', async () => {
  const text = await callTool(tools, 'review_brief', { repo: 'E:/work/app', diff: 'git diff HEAD~1', checks: 'node --check deploy.js → OK' });
  assert.ok(text.includes('仓库：E:/work/app'), '仓库没带上');
  assert.ok(text.includes('看 diff：git diff HEAD~1'), 'diff 命令没带上');
  assert.ok(text.includes('已有检查与结果：node --check deploy.js → OK'), '检查结果没带上');
});

const result = t.finish();
process.exit(result.fail ? 1 : 0);
