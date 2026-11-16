// <private>…</private>：模型或用户标记「这段不要落盘」。
// 和 redactSecrets 分工不同：打码处理「长得像凭据」的片段，这里处理「人明确说了别记」。
// 顺序是先摘标签再打码；摘掉之后正文变短、也不会再被当成记忆写进索引。
const PRIVATE_TAG = /<private>[\s\S]*?<\/private>/gi;

/** 文本里是否有成对的 <private>…</private>。 */
export function hasPrivate(text) {
  if (typeof text !== 'string' || !text) return false;
  PRIVATE_TAG.lastIndex = 0;
  const hit = PRIVATE_TAG.test(text);
  PRIVATE_TAG.lastIndex = 0;
  return hit;
}

/**
 * 摘掉 <private>…</private> 整段（连标签）。
 * @returns {{ text: string, removed: number }} removed 是被摘掉的段数。
 */
export function stripPrivate(text) {
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', removed: 0 };
  let removed = 0;
  const out = text.replace(PRIVATE_TAG, () => { removed += 1; return ''; });
  if (!removed) return { text, removed: 0 };
  return {
    text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    removed,
  };
}
