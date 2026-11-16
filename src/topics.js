/**
 * 记忆主题：给每条归档记忆贴一个粗粒度主题，让「按话题找」成为可能。
 *
 * 设计取舍：
 * - 只分 6 类，宁可落到「其他」也不硬塞。分类器猜错比没有分类更麻烦。
 * - 纯关键词计数，零模型调用、可复现；以后要换成语义分类，只需替换 topicOf。
 * - 词表刻意避开「可能出现在任何话题里」的词（比如「时间」「问题」），
 *   否则每条记忆都会同时命中所有类别。
 */

export const TOPICS = ['work', 'life', 'health', 'study', 'family', 'other'];

export const TOPIC_LABELS = {
  work: '工作',
  life: '生活',
  health: '健康',
  study: '学习',
  family: '家庭',
  other: '其他',
};

// 命中次数即权重；同一段文字命中越多次，越说明它真在聊这个话题。
const RULES = [
  ['health', /体检|医院|医生|吃药|处方|生病|发烧|感冒|咳嗽|过敏|手术|住院|血压|血糖|失眠|减肥|锻炼|牙医|挂科|复查/g],
  ['family', /我妈|我爸|老婆|老公|爱人|孩子|儿子|女儿|家人|亲戚|爷爷|奶奶|外公|外婆|生日|结婚|出生/g],
  ['work', /项目|客户|同事|老板|公司|需求|上线|发布|会议|汇报|工资|简历|面试|合同|预算|报价|代码|仓库|分支|版本|接口|插件|部署|测试/g],
  ['study', /学习|课程|考试|读书|看书|笔记|论文|英语|练习|教程|老师|课堂|作业|单词/g],
  // 「天气」「买」这类词太泛，出现在任何话题里，刻意不收。
  ['life', /吃饭|做菜|咖啡|旅行|出行|电影|游戏|衣服|房租|搬家|快递|宠物|猫|狗|周末|睡眠/g],
];

/**
 * 估一个主题。返回 `{ topic, hits }`，hits 是最高命中次数（0 表示只能落到「其他」）。
 */
export function topicOf(text) {
  const source = String(text || '');
  if (!source) return { topic: 'other', hits: 0 };
  let best = 'other';
  let bestHits = 0;
  for (const [topic, re] of RULES) {
    const matched = source.match(re);
    const hits = matched ? matched.length : 0;
    if (hits > bestHits) {
      bestHits = hits;
      best = topic;
    }
  }
  return { topic: best, hits: bestHits };
}

/** 主题的中文名；未知值一律当「其他」。 */
export function topicLabelOf(topic) {
  return TOPIC_LABELS[topic] || TOPIC_LABELS.other;
}

/** 只保留合法主题，非法值回落「其他」。 */
export function normalizeTopic(value) {
  return TOPICS.indexOf(value) >= 0 ? value : 'other';
}
