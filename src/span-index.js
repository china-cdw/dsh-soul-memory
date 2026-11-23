import { hash, redact, terms as termSet } from './util.js'
import { densestWindow, textOfEvent } from './session-search.js'
import { stripPrivate } from './memory/private.js'

/**
 * The addressable span index.
 *
 * Three properties matter and each is a fix for a measured failure:
 *  - incremental: only new events are ingested, so a turn costs what it appended, not the
 *    whole history (measured: 300 ms per turn at 9k events when re-harvested in full);
 *  - de-duplicated by content hash: a session repeats the same output dozens of times and
 *    those copies crowded the top of every result;
 *  - complete: the index lives on disk, so the silent 12k-event scan cap is gone.
 */

export const MAX_INGEST_PER_CALL = 4000

const CJK = /[\u3400-\u9FFF\uF900-\uFAFF]/g

/**
 * Split CJK into single characters for the index.
 *
 * FTS5's tokenizer treats a run of Han characters as one token, so "反作弊为什么失效" is a
 * single opaque word and a two-character query can never match it. Indexing it as
 * " 反 作 弊 …" turns every character into a token, and phrase queries then behave like
 * substring search.
 */
export const segment = text => String(text ?? '')
  .replace(CJK, ch => ` ${ch} `)
  .replace(/\s+/g, ' ')
  .trim()

/** A term as an FTS phrase, so a Chinese bigram requires adjacent characters. */
const phrase = term => `"${String(term).replace(CJK, ch => ` ${ch} `).replaceAll('"', '').replace(/\s+/g, ' ').trim()}"`

/**
 * Bring the index up to date, catching up in batches until done or the time budget runs out.
 *
 * A single bounded batch left a 37k-event session ten calls behind, which is indistinguishable
 * from the old scan cap: the earliest history simply was not there. Looping under a deadline
 * keeps one search bounded in time without leaving a permanent gap.
 */
export function ingest(store, scope, session, { max = MAX_INGEST_PER_CALL, budgetMs = 250 } = {}) {
  const sessionId = String(session?.id ?? 'default')
  const total = Number(session?.seq ?? 0)
  if (!(total > 0)) return { added: 0, watermark: store.spanWatermark(scope, sessionId), total: 0, remaining: 0, session: sessionId }

  const started = performance.now()
  let added = 0
  let watermark = store.spanWatermark(scope, sessionId)
  let remaining = 0

  for (;;) {
    const from = Math.max(0, watermark + 1)
    if (from >= total) break
    const to = Math.min(total - 1, from + max - 1)
    const rows = []
    for (let seq = from; seq <= to; seq++) {
      const event = session.eventAt(seq)
      if (!event) continue
      // Spans are raw tool output and user text: the one table that stores verbatim history
      // must pass the same denylist as every other write before it reaches disk.
      const text = redact(stripPrivate(textOfEvent(event)).text).trim()
      if (!text) continue
      rows.push({ seq, kind: String(event.type ?? ''), text, indexText: segment(text), hash: hash(text) })
    }
    added += store.putSpans(scope, sessionId, rows)
    store.setSpanWatermark(scope, sessionId, to)
    watermark = to
    remaining = Math.max(0, total - 1 - to)
    if (!remaining || performance.now() - started >= budgetMs) break
  }
  return { added, watermark, total, remaining, session: sessionId }
}

/**
 * Search the index and return a bounded set of spans.
 *
 * FTS5 first (bm25 ranking), substring second for queries the tokenizer cannot express —
 * a Windows path is one "word" to FTS and a literal to LIKE.
 *
 * `currentSession` is the id of the conversation asking. A span from any other session —
 * an earlier DSH conversation, or another agent's transcript — must not be marked
 * `current`, because `soul_expand` can only reopen the current conversation: a seq from
 * else­where would read a different passage.
 */
export function searchIndex(store, scope, query, { limit = 3, maxBytes = 4000, maxSpanBytes = 1200, currentSession = null, externalOnly = false } = {}) {
  const coverage = store.spanCoverage(scope)
  const terms = termSet(query)
  if (!terms.length || !coverage.spans) return { spans: [], bytes: 0, coverage }

  const match = terms.slice(0, 12).map(phrase).join(' OR ')
  // Spans imported from another agent carry a `agent:session` id. The filter has to run
  // inside the query (store.searchSpans `external`), not after LIMIT: otherwise local rows
  // fill the window and an external-only search reports "nothing" while hits exist.
  const external = externalOnly ? true : null
  let rows = []
  try { rows = store.searchSpans(scope, match, externalOnly ? limit * 8 : limit * 4, { external }) } catch { rows = [] }
  if (!rows.length) rows = store.findSpans(scope, String(query ?? '').trim(), externalOnly ? limit * 8 : limit * 2, { external })

  const needles = String(query ?? '').toLowerCase().split(/\s+/).filter(token => token.length >= 2)
  const spans = []
  let bytes = 0
  for (const row of rows) {
    if (spans.length >= limit || bytes >= maxBytes) break
    // 剩余预算不够一整段时，截到剩余长度收下，而不是 continue 把后面的命中全丢掉：
    // 原来预算还剩一大半就提前结束，返回的段数比 maxBytes 允许的少很多。
    const room = maxBytes - bytes
    const text = densestWindow(String(row.text ?? ''), Math.min(maxSpanBytes, Math.max(room, 80)), needles)
    const price = Buffer.byteLength(text)
    if (bytes + price > maxBytes) break
    spans.push({
      seq: row.seq,
      // A hit from an earlier session is labelled as such: the model must know it cannot
      // expand it, only read what is quoted here. An external hit is never "current",
      // even when the caller asked only for external rows.
      session: row.session ?? null,
      current: externalOnly ? false : (currentSession !== null && row.session === currentSession),
      // FTS5's bm25 is negative and smaller-is-better; flipping it makes every score in the
      // response read the same way (larger is more relevant), so a 0 fallback no longer looks
      // better than a real -4.2 hit.
      score: Math.round(-(Number(row.score) || 0) * 1000) / 1000,
      text,
    })
    bytes += price
  }
  return { spans, bytes, coverage }
}
