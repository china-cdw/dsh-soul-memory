import { readdirSync, statSync, readFileSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'
import { hash, redact } from './util.js'
import { segment } from './span-index.js'

/**
 * Other agents' session history, indexed into the same span table.
 *
 * deja-vu's strongest property is that it reads the transcripts every agent already
 * writes to disk, so a bug fixed in one tool is recallable from another. We cannot
 * port its Go indexer, but the part that matters fits here: walk the stores that
 * exist on this machine, lift the user/assistant text out of each transcript, and
 * write it as spans. A source's session id is prefixed with the agent name so a
 * result can say where it came from, and `span_meta` already tracks a per-file
 * watermark, which gives incremental reads for free.
 */

/** Store layouts verified against what these tools actually write. */
export const EXTERNAL_STORES = [
  {
    agent: 'qclaw',
    dir: () => join(homedir(), '.qclaw', 'agents'),
    // <root>/<agent>/sessions/<id>.jsonl, plus a sibling .trajectory.jsonl that holds
    // tool-level noise; the conversation is in the plain file.
    match: (name) => name.endsWith('.jsonl') && !name.endsWith('.trajectory.jsonl'),
    session: (path) => basename(path, '.jsonl'),
  },
  {
    agent: 'claude',
    dir: () => join(homedir(), '.claude', 'projects'),
    match: (name) => name.endsWith('.jsonl'),
    session: (path) => basename(path, '.jsonl'),
  },
]

/** Never read a whole multi-hundred-megabyte transcript into memory. */
const MAX_FILE_BYTES = 8 * 1024 * 1024
const MAX_LINES_PER_IMPORT = 4000

const walk = (dir, out, depth = 0) => {
  if (depth > 6) return out
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, out, depth + 1)
    else if (entry.isFile()) out.push(path)
  }
  return out
}

/** Every transcript this machine has, newest first, cheap enough to call on a search. */
export function listExternalSources({ stores = EXTERNAL_STORES } = {}) {
  const files = []
  for (const store of stores) {
    const root = store.dir()
    for (const path of walk(root, [])) {
      if (!store.match(basename(path))) continue
      let st
      try { st = statSync(path) } catch { continue }
      if (!st.isFile() || st.size === 0 || st.size > MAX_FILE_BYTES) continue
      files.push({ agent: store.agent, path, bytes: st.size, mtime: st.mtimeMs, session: `${store.agent}:${store.session(path)}` })
    }
  }
  return files.sort((a, b) => b.mtime - a.mtime)
}

/**
 * Pull one transcript message out of a parsed line.
 *
 * Both stores wrap the OpenAI-style `{role, content}` in an outer envelope, and an
 * assistant turn carries thinking parts alongside text; only `text` is history a
 * later search should surface.
 */
const textOfMessage = (message) => {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
}

const turnOfLine = (line) => {
  let row
  try { row = JSON.parse(line) } catch { return null }
  const message = row?.message ?? null
  const type = String(row?.type ?? '')
  if (!message || (type !== 'message' && type !== 'user' && type !== 'assistant')) return null
  const role = String(message.role ?? type)
  if (role !== 'user' && role !== 'assistant') return null
  const text = textOfMessage(message).trim()
  return text ? { role, text } : null
}

/**
 * Import what a transcript appended since the last visit.
 *
 * The watermark is a line number, which is the only stable cursor a JSONL append log
 * offers. `budgetMs` keeps one search bounded when a store is first discovered and has
 * months of history behind it.
 */
export function importExternal(store, scope, source, { maxLines = MAX_LINES_PER_IMPORT, budgetMs = 300 } = {}) {
  let text
  try { text = readFileSync(source.path, 'utf8') } catch { return { added: 0, skipped: true } }
  const lines = text.split('\n')
  // A JSONL file ends with a newline, which `split` turns into a trailing empty row.
  // Leaving it in makes the watermark point past the last real line, and the next
  // append then looks already-imported.
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const from = Math.max(0, store.spanWatermark(scope, source.session) + 1)
  if (from >= lines.length) return { added: 0, watermark: from - 1, remaining: 0 }

  const started = performance.now()
  let added = 0
  let line = from
  let rows = []
  for (; line < lines.length && rows.length < maxLines; line++) {
    const turn = turnOfLine(lines[line])
    if (!turn) continue
    const body = redact(turn.text).trim()
    if (!body) continue
    rows.push({ seq: line, kind: `${source.agent}:${turn.role}`, text: body, indexText: segment(body), hash: hash(body) })
  }
  // A batch that ends mid-file still advances the watermark only to the last line read,
  // so the next call resumes exactly where this one stopped.
  added = store.putSpans(scope, source.session, rows)
  const last = Math.max(from, line - 1)
  store.setSpanWatermark(scope, source.session, last)
  const remaining = Math.max(0, lines.length - 1 - last)
  return { added, watermark: last, remaining, session: source.session, elapsed: performance.now() - started }
}

/**
 * Index every store that has new turns, newest first, under a time budget.
 *
 * The first call on a machine with years of transcripts will not finish; that is
 * intended, and each later call picks up the next file. Nothing here is destructive.
 */
export function refreshExternal(store, scope, { budgetMs = 400, maxFiles = 6, stores = EXTERNAL_STORES } = {}) {
  const sources = listExternalSources({ stores })
  if (!sources.length) return { files: 0, added: 0, remaining: sources.length, sessions: [] }
  const started = performance.now()
  let files = 0
  let added = 0
  const sessions = []
  for (const source of sources) {
    if (files >= maxFiles || performance.now() - started >= budgetMs) break
    const result = importExternal(store, scope, source, { budgetMs: Math.max(50, budgetMs - (performance.now() - started)) })
    added += result.added ?? 0
    files++
    if (result.added) sessions.push(source.session)
    // Skip a file already at its end without spending the rest of the budget on it.
    if (!result.remaining) continue
  }
  return { files, added, remaining: sources.length, sessions }
}

/** Rows in the span table that came from another agent, by agent name. */
export function externalCoverage(store, scope) {
  const rows = store.db.prepare(
    "SELECT session FROM span WHERE scope=? AND session LIKE '%:%' GROUP BY session"
  ).all(scope)
  const agents = {}
  for (const row of rows) {
    const agent = String(row.session).split(':')[0]
    agents[agent] = (agents[agent] ?? 0) + 1
  }
  return agents
}
