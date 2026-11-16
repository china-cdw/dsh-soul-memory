// 按「样子」给记忆估个分量：不是判它该不该留，只是把明显是流水的一类排到后面。
// 纯规则、零模型调用。只有排序和回收门槛会用这个分，任何地方都不拿它删东西。

const CONCLUSION_WORDS = ['结论', '决定', '所以', '改成', '不要', '必须', '注意', '坑', '约定', '规范', '默认', '结论是'];
const CORRECTION_WORDS = ['不是', '而是', '改成', '别', '错了', '纠正'];
const CASUAL_WORDS = ['嗯', '也许', '随便', '看情况', '可能吧', '哈哈', '不知道', '再说吧'];
const CONCRETE = /[A-Za-z0-9_-]+\.(js|mjs|cjs|ts|tsx|json|md|py|css|html|yml|yaml|txt)\b|(?:[A-Za-z]:)?[\/\\][\w.\-]+[\/\\]|\bv?\d+\.\d+(\.\d+)?\b/;

function countAny(text, words) {
  let n = 0;
  for (const w of words) if (text.indexOf(w) >= 0) n += 1;
  return n;
}

/**
 * 给一段文本估分量。
 * @param {string} text 标题 + 正文
 * @returns {{ score: number, band: 'strong'|'normal'|'light', reasons: string[] }}
 */
export function scoreText(text) {
  const raw = String(text == null ? '' : text);
  const body = raw.replace(/\s+/g, ' ').trim();
  const chars = body.length;
  let score = 0.35;
  const reasons = [];

  if (chars < 30) { score -= 0.15; reasons.push('太短'); }
  else if (chars >= 400) { score += 0.12; reasons.push('有展开'); }
  else if (chars >= 120) { score += 0.1; reasons.push('够长'); }

  const conclusion = countAny(body, CONCLUSION_WORDS);
  if (conclusion) { score += Math.min(0.24, conclusion * 0.08); reasons.push('有结论'); }

  if (countAny(body, CORRECTION_WORDS) >= 2) { score += 0.1; reasons.push('有纠正'); }
  if (CONCRETE.test(body)) { score += 0.08; reasons.push('有具体对象'); }

  const casual = countAny(body, CASUAL_WORDS);
  if (casual) { score -= Math.min(0.24, casual * 0.12); reasons.push('偏口语'); }

  if (chars < 60 && /[?？]\s*$/.test(body)) { score -= 0.1; reasons.push('像提问'); }

  score = Math.max(0, Math.min(1, score));
  // 归档笔记天然「够长 + 有结论」，0.6 会让九成落进 strong、分档失去意义；
  // 抬到 0.75/0.5 后 strong 只留给「长、有结论、还带纠正或具体对象」的那批。
  const band = score >= 0.75 ? 'strong' : score >= 0.5 ? 'normal' : 'light';
  return { score: Math.round(score * 100) / 100, band, reasons };
}

export const BAND_LABELS = { strong: '强', normal: '中', light: '弱' };
