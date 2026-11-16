// 只读评审 brief：把「让新上下文的评审员挑毛病」固化成一个可直接派发的提示。
//
// 为什么需要它：口头说一句「你帮我看看」得到的评审，通常没有边界（改代码、跑部署、
// 顺手重构），也没有可核对的输出格式，最后变成一段客气的感想。这里把三件事写死：
//   1) 只读：不许改文件、不许提交/部署、不许再派子 agent；
//   2) 每条发现必须落到 文件:行号 + 严重度 + 具体改法；
//   3) 超时/报错/没输出都不算通过，最多 4 轮，到线交人裁决。
import { withNotes } from './tool-notes.js';

const MAX_FIELD = 1200;
// 评审最多几轮：到线就停，避免两个人各说各话无限循环。
export const MAX_ROUNDS = 4;

const clip = (text, max) => {
  const s = String(text ?? '').trim();
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
};

const line = (value, fallback) => {
  const s = clip(value, MAX_FIELD);
  return s || fallback;
};

/**
 * 生成一段只读评审 brief（纯函数，不碰文件系统，方便单测）。
 * @param {{repo?:string, base?:string, diff?:string, goal?:string, outOfScope?:string, checks?:string, round?:number, focus?:string}} options
 * @returns {string}
 */
export function buildReviewBrief(options = {}) {
  const repo = line(options.repo, '（未填：仓库根目录）');
  const base = line(options.base, 'HEAD');
  const diff = line(options.diff, 'git diff ' + base);
  const goal = line(options.goal, '（未填：一句话写清这次改动要达成什么——评审员据此判断哪些意见在范围内）');
  const outOfScope = line(options.outOfScope, '（未填：默认只评这次改动，不提无关重构、风格偏好和未来功能）');
  const checks = line(options.checks, '（未填：列出你实际跑过的检查命令和结果；没跑就说没跑）');
  const focus = line(options.focus, '正确性、边界与失败路径、范围是否失控');
  const round = Number.isFinite(options.round) && options.round > 0 ? Math.floor(options.round) : 1;
  const last = round >= MAX_ROUNDS;

  const out = [];
  out.push('你是一个只读评审员。这一轮只挑毛病，不改任何东西。');
  out.push('');
  out.push('硬约束（违反任何一条，这轮评审作废）：');
  out.push('- 只读：不要编辑/新建/删除文件，不要 commit/push，不要部署，不要跑会写盘的命令，不要再派子 agent。');
  out.push('- 只依据仓库里的真实代码和下面给出的检查结果判断；没打开过的文件不要猜，猜的必须标【推断】。');
  out.push('- 超时、工具报错、命令没有输出，都不算通过；只能在结论里写「这项没验证」。');
  out.push('');
  out.push('仓库：' + repo);
  out.push('基线：' + base);
  out.push('看 diff：' + diff);
  out.push('目标（一句话）：' + goal);
  out.push('范围外（不要提这类意见）：' + outOfScope);
  out.push('重点看：' + focus);
  out.push('已有检查与结果：' + checks);
  out.push('');
  out.push('输出格式（严格照这个写，不要写别的段落）：');
  out.push('VERDICT: APPROVE 或 CHANGES');
  out.push('SCORE: x/10');
  out.push('然后每条发现一行：');
  out.push('R{序号} [blocker|should|nit] 文件:行号 一句话说清问题. Fix: 具体改法');
  out.push('');
  out.push('判定口径：');
  out.push('- blocker = 会出错/会丢数据/会让守卫失效；should = 该改但不至于出错；nit = 可选。');
  out.push('- 没有足够证据的问题不要列成确定缺陷，写成「待确认：…（缺什么证据）」。');
  out.push('- 只说这次改动；不要提无关重构、命名偏好、未来功能。');
  out.push('- 每条 finding 都要能指着具体代码；指不到的不要写。');
  out.push('');
  out.push('这是第 ' + round + ' 轮，最多 ' + MAX_ROUNDS + ' 轮。');
  if (last) {
    out.push('已经是最后一轮：还不同的意见就停下来，把双方理由和证据一起交给人裁决，不要再改。');
  } else {
    out.push('如果上一轮的意见已经被改掉，就逐条确认改法是否真的解决了问题，不要只看到改动就放行。');
  }
  return out.join('\n');
}

/** 注册 review_brief 工具。 */
export function registerReview(ctx) {
  ctx.tools.register({
    name: 'review_brief',
    description: withNotes('生成一份「只读评审」的提示词：写死只读边界、每条发现必须带 文件:行号 + 严重度 + 具体改法、超时/报错不算通过、最多 4 轮。用法：先填 goal / base / checks，再把返回的整段文字作为 subagent 的 prompt 派出去（评审员只读，不改文件）。',
      '纯本地拼字符串；不读文件、不调用模型、不花钱；返回内容就是可以直接粘贴的评审 brief。'),
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        goal: { type: 'string', description: '这次改动要达成什么（一句话；评审员据此判断哪些意见在范围内）' },
        repo: { type: 'string', description: '仓库根目录；不填用当前会话目录' },
        base: { type: 'string', description: '对比基线（分支/提交/父提交），默认 HEAD' },
        diff: { type: 'string', description: '看 diff 的命令，默认 git diff <base>' },
        outOfScope: { type: 'string', description: '范围外的事（评审员不要提）' },
        checks: { type: 'string', description: '你已经跑过的检查命令与结果，例如 node --check deploy.js → OK' },
        focus: { type: 'string', description: '重点看什么，默认正确性、边界与失败路径、范围是否失控' },
        round: { type: 'number', description: '第几轮评审（默认 1，最多 4 轮，到线交人裁决）' },
      },
    },
    async execute(args = {}, exec) {
      const cwd = exec?.agent?.session?.header?.cwd || '';
      const round = Number.isFinite(args.round) ? Math.floor(args.round) : 1;
      return buildReviewBrief({
        repo: args.repo || cwd || undefined,
        base: args.base,
        diff: args.diff,
        goal: args.goal,
        outOfScope: args.outOfScope,
        checks: args.checks,
        focus: args.focus,
        round,
      });
    },
  });
}
