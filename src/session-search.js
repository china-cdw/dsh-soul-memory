import { bounded, terms as termSet } from './util.js'

/**
 * Retrieval over the live session's own history.
 *
 * The checkpoint should not have to carry details: the details are still in the event log, and
 * a plugin can address that log in-process through `session.surface.nodes` + `eventAt(seq)`.
 * This module is the "dereference" half of indexed memory — cheap, exact, and auditable,
 * with no embedding and no model call.
 */

const MAX_SCAN = 12000
const MAX_SPAN_BYTES = 1200
const MAX_TOTAL_BYTES = 4000

/** Extract the human-readable text of one session event, defensively across event shapes. */
export function textOfEvent(event) {
  const data = event?.data
  const content = data?.message?.content ?? data?.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(block => {
      if (typeof block?.text === 'string') return block.text
      if (block?.type === 'tool-result' && Array.isArray(block.content)) {
        return block.content.map(inner => typeof inner?.text === 'string' ? inner.text : '').join('\n')
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  return typeof data?.text === 'string' ? data.text : ''
}

const harvestCache = new WeakMap()

/**
 * Walk the live surface and collect addressable spans.
 *
 * Cached per session and invalidated by surface length: a tool called mid-turn should not
 * re-extract a megabyte of history on every query, but it must never serve a stale surface.
 */
export function harvest(session) {
  if (typeof session?.eventAt !== 'function') return []
  const total = Number(session.seq ?? session.log?.length ?? 0)
  const nodes = Array.isArray(session?.surface?.nodes) ? session.surface.nodes : null
  const useLog = Number.isInteger(total) && total > 0
  const order = useLog
    ? Array.from({ length: Math.min(total, MAX_SCAN) }, (_, i) => Math.max(0, total - MAX_SCAN) + i)
    : nodes ?? []
  if (!order.length) return []

  const key = useLog ? `log:${total}` : `surface:${order.length}:${order[order.length - 1]}`
  const cached = harvestCache.get(session)
  if (cached && cached.key === key) return cached.spans

  const spans = []
  for (const seq of order) {
    const event = session.eventAt(seq)
    if (!event) continue
    const text = textOfEvent(event).trim()
    if (!text) continue
    spans.push({ seq, type: String(event.type ?? ''), text, terms: [...new Set(termSet(text))] })
  }
  harvestCache.set(session, { key, spans })
  return spans
}

/** Sparse idf over the span collection: a term found everywhere says nothing. */
function weightTerms(spans) {
  const frequency = new Map()
  for (const span of spans) for (const term of span.terms ?? new Set(termSet(span.text))) {
    frequency.set(term, (frequency.get(term) ?? 0) + 1)
  }
  return term => Math.log2(1 + spans.length / (1 + (frequency.get(term) ?? 1)))
}

/** Grow a byte-bounded slice around [from, to) so the matched literal is never cut off. */
function sliceAround(text, from, to, limit) {
  let start = from
  let end = to
  let bytes = Buffer.byteLength(text.slice(from, to))
  while (bytes < limit) {
    let grew = false
    if (end < text.length) {
      const size = Buffer.byteLength(text[end])
      if (bytes + size <= limit) { bytes += size; end++; grew = true }
    }
    if (start > 0) {
      const size = Buffer.byteLength(text[start - 1])
      if (bytes + size <= limit) { bytes += size; start--; grew = true }
    }
    if (!grew) break
  }
  // 不切断代理对：末尾若只剩高代理项就回退一位（宁可少 3 字节，也不返回非法 UTF-16）。
  if (end > start && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) end -= 1
  // 左边界同理：起点落在低代理项上时，把它的高位一起纳入，否则会返回孤立低代理。
  if (start < end && start > 0) {
    const c = text.charCodeAt(start)
    if (c >= 0xdc00 && c <= 0xdfff) start -= 1
  }
  // 预算连一个字符都放不下时返回空串（严格不超预算），由调用方提示提高 limit；
  // 不能违背「不超过 limit」的承诺去返回半个字符。
  if (end === start) {
    const cp = text.codePointAt(start)
    if (cp === undefined) return ''
    const ch = String.fromCodePoint(cp)
    return Buffer.byteLength(ch) <= limit ? ch : ''
  }
  return text.slice(start, end)
}

/** The densest window of a long span, so a 40 KB tool result yields its load-bearing line. */
export function densestWindow(text, limit, needles) {
  if (Buffer.byteLength(text) <= limit) return text
  // Size the window in characters from the text's own byte-per-character ratio: a fixed
  // character count would overrun the byte budget by three times on Chinese prose.
  // A literal hit is the common case and the cheap one: centre on it instead of scoring windows.
  for (const needle of [...needles].sort((a, b) => b.length - a.length)) {
    const at = text.toLowerCase().indexOf(needle.toLowerCase())
    if (at >= 0) return sliceAround(text, at, at + needle.length, limit)
  }
  const bytesPerChar = Math.max(1, Buffer.byteLength(text) / Math.max(1, text.length))
  const width = Math.max(32, Math.floor(limit / bytesPerChar))
  const starts = []
  const stride = Math.max(16, Math.floor(width / 4))
  for (let start = 0; start + width <= text.length; start += stride) starts.push(start)
  // The tail needs its own window: a needle in the last `width` characters is otherwise never
  // scored, which is exactly where logs put their summary line.
  if (text.length > width) starts.push(text.length - width)
  let best = { score: -1, start: 0 }
  for (const start of starts) {
    const slice = text.slice(start, start + width)
    let score = 0
    for (const needle of needles) if (slice.includes(needle)) score += needle.length
    if (score > best.score) best = { score, start }
  }
  const window = text.slice(best.start, best.start + width)
  return best.score <= 0 ? bounded(text, limit) : bounded(window, limit)
}

/**
 * Rank spans against a query and return a few of them, bounded in bytes.
 *
 * @returns {{spans: Array<{seq:number,type:string,score:number,text:string}>, scanned:number, bytes:number}}
 */
export function searchSpans(spans, query, { limit = 3, maxSpanBytes = MAX_SPAN_BYTES, maxTotalBytes = MAX_TOTAL_BYTES } = {}) {
  const queryTerms = termSet(query)
  if (!spans.length || !queryTerms.length) return { spans: [], scanned: spans.length, bytes: 0 }
  const idf = weightTerms(spans)
  const needleList = String(query ?? '').toLowerCase().split(/\s+/).filter(token => token.length >= 2)

  const scored = []
  for (const span of spans) {
    const own = span.terms ? new Set(span.terms) : new Set(termSet(span.text))
    let score = 0
    for (const term of queryTerms) if (own.has(term)) score += idf(term)
    // An exact literal hit (a path, a code) outranks partial term overlap.
    const lower = span.text.toLowerCase()
    for (const needle of needleList) if (lower.includes(needle)) score += 2 * idf(needle)
    if (score > 0) scored.push({ span, score })
  }
  scored.sort((a, b) => b.score - a.score || b.span.seq - a.span.seq)

  const picked = []
  const usedSeqs = new Set()
  let bytes = 0
  for (const { span, score } of scored) {
    if (picked.length >= limit || bytes >= maxTotalBytes) break
    if (usedSeqs.has(span.seq)) continue
    const text = densestWindow(span.text, maxSpanBytes, needleList)
    const price = Buffer.byteLength(text)
    if (bytes + price > maxTotalBytes) continue
    picked.push({ seq: span.seq, type: span.type, score: Math.round(score * 100) / 100, text })
    usedSeqs.add(span.seq)
    bytes += price
  }
  return { spans: picked, scanned: spans.length, bytes }
}

/**
 * Convenience: search the live session directly.
 * Returns a note instead of throwing when the host exposes no addressable surface.
 */
export function searchSession(session, query, options) {
  const spans = harvest(session)
  if (!spans.length) return { spans: [], scanned: 0, bytes: 0, note: '会话没有可检索的原文' }
  return searchSpans(spans, query, options)
}

/**
 * Read one addressable range verbatim.
 *
 * This is the other half of a directory card: the card says `[97-210]`, this returns exactly
 * those events, bounded, so a pointer costs one call and a known number of bytes.
 */
const MAX_EXPAND_BYTES = 20000
const MAX_EXPAND_EVENTS = 1000
// 会话 seq 的硬上界：即使调用方绕过参数校验，也不能让同步循环无限抬高。
const MAX_SEQ = 1000000

/** 从第 n 个字节起取剩余文本；不切断多字节字符。 */
function skipBytesSafe(text, n) {
  if (!text || n <= 0) return text
  let used = 0
  let i = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch)
    if (used + size > n) break
    used += size
    i += ch.length
  }
  return text.slice(i)
}

export function expandRange(session, from, to, { limit = 2000, maxEvents = 200, offset = 0 } = {}) {
  const budgetRaw = limit == null ? 2000 : (Number.isFinite(Number(limit)) ? Math.floor(Number(limit)) : 2000)
  const capRaw = maxEvents == null ? 200 : (Number.isFinite(Number(maxEvents)) ? Math.floor(Number(maxEvents)) : 200)
  // 硬闸门：调用方可以缩小预算，但不能突破单次工具结果的体积/条数上限。
  const budget = Math.min(MAX_EXPAND_BYTES, budgetRaw)
  const cap = Math.min(MAX_EXPAND_EVENTS, capRaw)
  const skipBytes = Number.isFinite(Number(offset)) ? Math.max(0, Math.floor(Number(offset))) : 0
  const rawFrom = Number(from)
  const rawTo = Number(to)
  // 逐端归一：一个端点坏掉不该把另一个有效端点一起丢掉。
  const fromNum = Number.isFinite(rawFrom) ? Math.max(0, Math.floor(rawFrom)) : 0
  const toNum = Number.isFinite(rawTo) ? Math.max(0, Math.floor(rawTo)) : fromNum
  const start = Math.max(0, Math.min(fromNum, toNum))
  const end = Math.min(Math.max(0, Math.max(fromNum, toNum)), MAX_SEQ)
  if (budget <= 0) return { from: start, to: start - 1, next: start, bytes: 0, text: '', events: 0, truncated: start <= end, note: 'limit 为 0 或负数：未处理任何事件（to=start-1，start=0 时 to=-1 表示一条都没读；续读请用 from=from 重发并提高 limit）' }
  if (cap <= 0) return { from: start, to: start - 1, next: start, bytes: 0, text: '', events: 0, truncated: start <= end, note: 'maxEvents 为 0：未处理任何事件（to=start-1，start=0 时 to=-1 表示一条都没读；续读请用 from=from 重发并提高 maxEvents）' }
  if (typeof session?.eventAt !== 'function') return { from: start, to: end, bytes: 0, text: '', events: 0, truncated: false, note: '会话没有可读的原文接口' }
  const parts = []
  let events = 0
  let last = start - 1
  let bytes = 0
  let hitCap = false
  let hitBytes = false
  let clipped = false
  let clipSkip = 0
  let pendingSkip = skipBytes
  for (let seq = start; seq <= end; seq++) {
    if (events >= cap) { hitCap = true; break }
    const event = session.eventAt(seq)
    // 指定区间的起点不存在时也要清掉 offset：否则 skip 会顺延到下一条真实事件，
    // 悄悄吃掉它的开头（offset 只作用于调用方指定的那一条事件）。
    if (!event) { pendingSkip = 0; continue }
    const text = textOfEvent(event).trim()
    // 即使这条事件为空，也要先把 offset 消费掉：否则 skip 会顺延到后面的条目，
    // 悄悄吃掉下一条事件的开头。
    // offset 只作用于调用方指定的那一条事件，用掉即清零；否则会连带切掉后续事件。
    let body = text
    let eventSkip = 0
    // 只有这条事件真的被裁剪时才需要把它的 skip 计入游标；跳空的事件不贡献字节。
    if (pendingSkip > 0) { eventSkip = pendingSkip; body = skipBytesSafe(text, pendingSkip); pendingSkip = 0 }
    if (!body) { last = seq; continue }
    const size = Buffer.byteLength(body) + (parts.length ? 1 : 0)
    // 预算按字节算：对外承诺的是“不超过 2KB”，不能再按字符截。
    if (bytes + size > budget) {
      hitBytes = true
      // 单条事件本身就超预算：不能直接 break，否则 to 不前进、这条永远读不到。
      // 退化为保留该条的前若干字节（严格不超过 budget），并把 to 前进到它。
      if (!parts.length) {
        const cut = sliceAround(body, 0, 0, budget)
        if (cut) {
          parts.push(cut)
          bytes = Buffer.byteLength(cut)
          events = 1
          clipped = true
          clipSkip = eventSkip
          // 只有真的返回了内容才前进 to；预算连一个字符都放不下时不能假装读过。
          last = seq
        }
      }
      break
    }
    parts.push(body)
    bytes += size
    events++
    last = seq
  }
  const text = parts.join('\n')
  // 条数上限触发时再看一眼后面还有没有可读事件；没有就不算截断（只是区间读完了）。
  if (hitCap) {
    let more = false
    for (let seq = last + 1; seq <= end; seq++) {
      const ev = session.eventAt(seq)
      if (!ev) continue
      if (textOfEvent(ev).trim()) { more = true; break }
    }
    if (!more) hitCap = false
  }
  // 尾部没有可读事件不等于被截断：只有「条数上限 / 字节上限 / 首条被裁剪」才算。
  const truncated = hitCap || hitBytes || clipped
  // 首条事件被裁剪时，剩余内容必须能从断点续读；否则客户端按 to+1 续读会永久丢掉后半段。
  // offset 只对被裁剪的那条事件有意义：被 skip 掉又整条落空的事件不贡献字节。
  const resume = clipped ? { seq: last, offset: clipSkip + Buffer.byteLength(parts[0] ?? '') } : null
  // 一条可读事件都没有时，to 直接落到 end：区间已扫完，避免客户端反复重试同一段。
  const endSeq = last >= start ? last : (events === 0 && !truncated ? end : start - 1)
  return {
    from: start,
    to: endSeq,
    bytes: Buffer.byteLength(text),
    text,
    events,
    truncated,
    ...(resume ? { resume } : {}),
    ...(truncated ? { note: '已截断：仅返回 ' + events + ' 条事件 / ' + Buffer.byteLength(text) + ' 字节' + (events === 0 ? '（预算不足一个字符，请提高 limit（≥4）后重试）' : '') + (clipped ? '（首条事件超出预算，已裁剪；续读用 from=resume.seq 并传 offset=resume.offset）' : '') + '。' } : {}),
  }
}
