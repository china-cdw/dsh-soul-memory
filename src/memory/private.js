// <private>…</private>：模型或用户标记「这段不要落盘」。
// 和 redactSecrets 分工不同：打码处理「长得像凭据」的片段，这里处理「人明确说了别记」。
// 顺序是先摘标签再打码；摘掉之后正文变短、也不会再被当成记忆写进索引。
//
// 这里按标签深度扫描，而不是用 /<private>.*?<\/private>/ 正则：
// 1) 未闭合的 <private> 不会原样落盘（从它开始到文末整段摘掉，并回报 unclosed）；
// 2) 嵌套时不会只摘到内层闭合就收手，把外层剩下的私密内容漏出去；
// 3) 标签里允许空白（< private >、</ private>），也认得着零宽字符和 HTML 实体写法——
//    这些都是「同一个意思、不同写法」，按字面匹配就会漏。
//
// 归一化只用于「找到标签在哪」：所有切片都按原文下标做，正文其他字符一个不改。

const TAG_RE_SOURCE = '<(\\s*\\/?\\s*)private\\s*>';

/** 去掉零宽字符、把 &lt; / &gt; 折回 < / >，同时记住每个归一化字符对应的原文区间。 */
function normalizeForScan(text) {
  const chars = [];
  const starts = [];
  const ends = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // 零宽空格/连接符/方向符、BOM：视觉上不可见，填在标签里就是为了绕开匹配。
    if (ch === '\u200B' || ch === '\u200C' || ch === '\u200D' || ch === '\uFEFF') { i += 1; continue; }
    if (ch === '&') {
      const window = text.slice(i, i + 6);
      const lt = /^&(?:lt|#60|#x3c);/i.exec(window);
      if (lt) { chars.push('<'); starts.push(i); ends.push(i + lt[0].length); i += lt[0].length; continue; }
      const gt = /^&(?:gt|#62|#x3e);/i.exec(window);
      if (gt) { chars.push('>'); starts.push(i); ends.push(i + gt[0].length); i += gt[0].length; continue; }
    }
    chars.push(ch); starts.push(i); ends.push(i + 1); i += 1;
  }
  return { text: chars.join(''), starts, ends };
}

function hasTag(normalized) {
  return new RegExp(TAG_RE_SOURCE, 'i').test(normalized);
}

/** 真正的深度扫描。initialOpen=true 表示这段文本从一个更早片段里的私密段中间开始。 */
function runScan(text, scan, initialOpen) {
  const tag = new RegExp(TAG_RE_SOURCE, 'gi');
  let out = '';
  let last = 0;
  let depth = initialOpen ? 1 : 0;
  let start = initialOpen ? 0 : -1;
  let removed = 0;
  let unclosed = false;
  let match;
  while ((match = tag.exec(scan.text))) {
    const from = scan.starts[match.index];
    const to = scan.ends[tag.lastIndex - 1];
    const closing = match[1].indexOf('/') >= 0;
    if (!closing) {
      if (depth === 0) { start = from; depth = 1; } else depth += 1;
      continue;
    }
    if (depth > 0) {
      depth -= 1;
      if (depth === 0) {
        out += text.slice(last, start);
        last = to;
        removed += 1;
      }
      continue;
    }
    // 孤立的 </private>：没有开标签可配，最可能是上一个分片开了口。按「私密段从这里开始」
    // 处理，一直摘到文末——宁可多摘一段，也不把用户标注过的内容留在盘上。
    start = from;
    depth = 1;
  }
  if (depth > 0) {
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

/**
 * 摘掉 <private>…</private> 整段（连标签）。
 * @returns {{ text: string, removed: number, unclosed: boolean }} removed 是被摘掉的段数。
 */
export function stripPrivate(text) {
  if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', removed: 0, unclosed: false };
  const scan = normalizeForScan(text);
  // 快速判断：连标签形状都没有，原样返回（绝大多数文本走这里）。
  if (!hasTag(scan.text)) return { text, removed: 0, unclosed: false };
  return runScan(text, scan, false);
}

/**
 * 有状态的摘除器：跨分片保持「上一段还没闭合」的状态。
 * 一条消息被拆成两次 push 时（"记住这个 <private>密码是 x" + "邮箱 y</private>"），
 * 单次调用各自判断会把第二段整段漏出去；这里把状态记在会话上，
 * 直到遇到闭合标签为止都按私密处理。
 */
export function createPrivateStripper() {
  let open = false;
  function strip(text) {
    if (typeof text !== 'string' || !text) return { text: typeof text === 'string' ? text : '', removed: 0, unclosed: open };
    const scan = normalizeForScan(text);
    if (!open && !hasTag(scan.text)) return { text, removed: 0, unclosed: false };
    const result = runScan(text, scan, open);
    open = result.unclosed;
    return result;
  }
  // 回合结束复位：分片只在同一回合内有效。用户漏写 </private> 时，
  // 这一条消息后面的内容仍按私密处理（安全），但下一条用户消息不会被继续吞掉（可用）。
  strip.reset = () => { open = false; };
  return strip;
}

/** 深拷贝并摘掉任意结构里的 <private> 段（事件 data 可能是数组/嵌套对象）。 */
export function stripPrivateDeep(value, strip = null) {
  const cut = typeof strip === 'function' ? strip : stripPrivate;
  if (typeof value === 'string') return cut(value).text;
  if (Array.isArray(value)) return value.map(item => stripPrivateDeep(item, cut));
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = stripPrivateDeep(value[key], cut);
    return out;
  }
  return value;
}
