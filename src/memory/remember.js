// 用户说「以后记住 / 记住怎么做」时，插件补一句确定性的提醒：
// 不依赖模型这一轮是否愿意调用 memory_write，先让它看见「这条要求值得落盘」。
//
// 只认「明确的长期要求」，不认顺口一提：
//   - 强信号直接命中：记住 / 记一下 / 记下来 / 记着 / 长期记住 / 永久保存 / 存一下 /
//     以后 + (都|用|按|一律|默认|要|别|不要|就|开始|不再) /
//     每次 + (都|用|要|别|不要) / 下次 + (别|不要)
//   - 弱信号（记得 / 别再 / 不要再）必须同句带「以后/今后/往后/下次/每次/长期/永久/一直」才算
//   - 问句（吗/么/呢 结尾）与「不记得 / 你还记得…」一律不算
// 英文同理：remember 只在祈使句或 from now on 等短语里算，排除 do you remember / don't remember。

const STRONG_ZH = /(记住|记一下|记下来|记着|长期记住|永久保存|存一下|记录一下|(?:以后|今后|往后)(?:都|用|按|一律|默认|要|别|不要|就|开始|不再)|每次(?:都|用|要|别|不要)|下次(?:别|不要))/
const WEAK_ZH = /(记得|别再|不要再)/
const FUTURE_ZH = /(以后|今后|往后|下次|每次|长期|永久|一直)/
const QUESTION_TAIL = /(吗|么|呢)[。！!…]*$/
const STRONG_EN = /\b(from now on|going forward|keep in mind|always use|never again|remember (?:this|that)|note that)\b/i
const WEAK_EN = /\bremember\b/i
const NOT_EN = /\b(?:don'?t|do not|not|never)\s+remember\b|\bdo you remember\b/i

const norm = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** 命中词所在的句子（用于判断是不是问句）。 */
function clauseAt(s, index) {
  let start = 0
  for (const mark of ['。', '！', '!', '？', '?']) {
    const at = s.lastIndexOf(mark, index - 1)
    if (at + 1 > start) start = at + 1
  }
  let end = s.length
  for (const mark of ['。', '！', '!', '？', '?']) {
    const at = s.indexOf(mark, index)
    if (at !== -1 && at < end) end = at
  }
  return s.slice(start, end)
}

const isQuestion = (s, index) => QUESTION_TAIL.test(clauseAt(s, index).trim())

/** 在 s 里找第一个可用的匹配；accept 为假时继续往后找。 */
function firstUsable(s, re, accept) {
  const r = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
  let m
  while ((m = r.exec(s)) !== null) {
    if (accept(m)) return m
    if (r.lastIndex === m.index) r.lastIndex += 1
  }
  return null
}

/**
 * 用户这句话是不是在要求「长期记住」。
 * 命中返回 { index, weak }（index 是规整后文本里的位置，用来取原话窗口），否则 null。
 */
export function rememberMatch(text) {
  const s = norm(text)
  if (!s) return null
  const strong = firstUsable(s, STRONG_ZH, (m) => !isQuestion(s, m.index))
  if (strong) return { index: strong.index, weak: false }
  const weak = firstUsable(s, WEAK_ZH, (m) => !isQuestion(s, m.index) && FUTURE_ZH.test(clauseAt(s, m.index)))
  if (weak) return { index: weak.index, weak: true }
  const enStrong = firstUsable(s, STRONG_EN, (m) => !isQuestion(s, m.index))
  if (enStrong) return { index: enStrong.index, weak: false }
  if (NOT_EN.test(s)) return null
  const enWeak = firstUsable(s, WEAK_EN, (m) => !isQuestion(s, m.index))
  if (enWeak) return { index: enWeak.index, weak: true }
  return null
}

export function rememberIntent(text) {
  return rememberMatch(text) !== null
}

/**
 * 取原话：优先取命中位置前后的窗口，而不是永远从第 0 个字开始。
 * 长消息末尾才说「记住」时，从头部截会把最关键的半句切掉。
 */
export function rememberExcerpt(text, max = 200, at = 0) {
  const s = norm(text)
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  const start = Math.max(0, Math.min(Math.max(0, at) - half, s.length - max))
  return (start > 0 ? '…' : '') + s.slice(start, start + max) + (start + max < s.length ? '…' : '')
}

export function rememberReminder(text, at = 0) {
  return '[长期记忆要求] 用户这句话像是在要求「以后记住」。'
    + '如果确实是长期要求，先用 memory_write 存成自包含笔记（长期稳定的再用 memory_core 写进核心记忆），存完再回答；'
    + '如果只是顺口一提，忽略本条即可。已经存过就不要重复存，也不要为同一句写两条。'
    + '原话：' + rememberExcerpt(text, 200, at)
}
