// 记忆主题与「按会话类型注入」的自检。
//
// 只测纯函数：topicOf / topicLabelOf / normalizeTopic / isCodeDir。
// 只在 isCodeDir 里碰磁盘（临时目录造一个 package.json）。
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { suite } from './_testkit.mjs';
import { TOPICS, TOPIC_LABELS, topicOf, topicLabelOf, normalizeTopic } from '../src/topics.js';
import { isCodeDir } from '../src/coding.js';

const s = suite('dsh-memory-topics');

await s.test('按词表估主题：工作 / 生活 / 健康 / 学习 / 家庭 / 其他', () => {
  eq(topicOf('把插件升级到 0.4.10，接口和版本号都改了').topic, 'work', '代码/项目 → 工作');
  eq(topicOf('周末去看电影，然后找个咖啡店坐坐').topic, 'life', '电影/咖啡 → 生活');
  eq(topicOf('明天去医院复查，最近总是失眠').topic, 'health', '医院/失眠 → 健康');
  eq(topicOf('英语课的老师布置了论文作业').topic, 'study', '课程/论文 → 学习');
  eq(topicOf('我妈生日是 3 月 5 号，别忘买蛋糕').topic, 'family', '妈/生日 → 家庭');
  eq(topicOf('今天天气不错').topic, 'other', '没有明显主题 → 其他');
});

await s.test('空文本与多命中：空返回 other，命中多的赢', () => {
  const empty = topicOf('');
  eq(empty.topic, 'other', '空文本 → 其他');
  eq(empty.hits, 0, '空文本命中 0 次');
  eq(topicOf('项目要上线，客户催这个项目，代码还没合并，晚上吃饭').topic, 'work', '多命中压过单命中');
});

await s.test('标签与归一化', () => {
  eq(topicLabelOf('health'), '健康', '主题标签');
  eq(topicLabelOf('nope'), '其他', '未知主题回落其他');
  eq(normalizeTopic('study'), 'study', '合法主题原样返回');
  eq(normalizeTopic('乱写'), 'other', '非法主题归一成其他');
  eq(TOPICS.length, 6, '一共 6 个主题');
  eq(Object.keys(TOPIC_LABELS).length, TOPICS.length, '标签与主题一一对应');
});

await s.test('isCodeDir 决定编码规范注不注入', () => {
  const plain = mkdtempSync(join(tmpdir(), 'soul-topic-plain-'));
  const code = mkdtempSync(join(tmpdir(), 'soul-topic-code-'));
  try {
    eq(isCodeDir(plain), false, '空目录不算代码目录');
    writeFileSync(join(code, 'package.json'), '{}');
    eq(isCodeDir(code), true, '有 package.json 就算代码目录');
    eq(isCodeDir(null), true, '拿不到目录时按代码目录处理（宁可多注入）');
    eq(isCodeDir(join(plain, '不存在')), true, '目录读不到时也不吞规则');
  } finally {
    rmSync(plain, { recursive: true, force: true });
    rmSync(code, { recursive: true, force: true });
  }
});

s.finish();

function eq(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(label + '：期望 ' + JSON.stringify(expected) + '，实际 ' + JSON.stringify(actual));
  }
}
