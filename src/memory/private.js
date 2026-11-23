// <private>…</private>：模型或用户标记「这段不要落盘」。
// 和 redactSecrets 分工不同：打码处理「长得像凭据」的片段，这里处理「人明确说了别记」。
// 顺序是先摘标签再打码；摘掉之后正文变短、也不会再被当成记忆写进索引。
//
// 这里按标签深度扫描，而不是用 /<private>.*?<\/private>/ 正则：
// 1) 未闭合的 <private> 不会原样落盘（从它开始到文末整段摘掉，并回报 unclosed）；
// 2) 嵌套时不会只摘到内层闭合就收手，把外层剩下的私密内容漏出去。

/** 文本里是否有成对的 <private>…</private>。 */
export function hasPrivate(text) {
  if (typeof text !== 'string' || !text) return false;
  return /<private>[\s\S]*?<\/private>/i.test(text);
}

/** 深拷贝并摘掉任意结构里的 <private> 段（事件 data 可能是数组/嵌套对象）。 */
export function stripPrivateDeep(value) {
  if (typeof value === 'string') return stripPrivate(value).text;
  if (Array.isArray(value)) return value.map(stripPrivateDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = stripPrivateDeep(value[key]);
    return out;
  }
  return value;
}

/**
 * 摘掉 <private>…</private> 整段（连标签）。
 * @returns {{ text: string, removed: number, unclosed: boolean }} removed 是被摘掉的段数。
 */
export function stripPrivate(text) {
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', removed: 0, unclosed: false };
  // 只有单个 </private> 也要走扫描：否则它会原样留在正文里。
  if (!/<private>/i.test(text) && !/<\/private>/i.test(text)) return { text, removed: 0, unclosed: false };
  let out = '';
  let last = 0;
  let depth = 0;
  let start = -1;
  let removed = 0;
  let unclosed = false;
  const tag = /<(\/?)private>/gi;
  let match;
  while ((match = tag.exec(text))) {
    if (!match[1]) {
      if (depth === 0) start = match.index;
      depth += 1;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        out += text.slice(last, start);
        last = tag.lastIndex;
        removed += 1;
      }
      continue;
    }
    // 没有对应开标签的 </private>：只丢标签，不动正文。
    out += text.slice(last, match.index);
    last = tag.lastIndex;
  }
  if (depth > 0) {
    // 有开无合：从它开始到文末全部算私密，宁可比用户想的多摘一段。
    out += text.slice(last, start);
    removed += 1;
    unclosed = true;
  } else {
    out += text.slice(last);
  }
  if (!removed) return { text: out, removed: 0, unclosed };
  return {
    text: out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim(),
    removed,
    unclosed,
  };
}
