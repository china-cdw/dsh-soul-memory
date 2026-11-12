import { expandRange } from '../src/session-search.js'
const events = [
  { seq: 1, data: { text: 'AAAA' } },
  { seq: 2, data: { text: 'B'.repeat(3000) } },
]
const session = { eventAt: (s) => events.find(e => e.seq === s) ?? null }
const a = expandRange(session, 1, 2, { limit: 2000, offset: 4 })
console.log('A', JSON.stringify({to:a.to, bytes:a.bytes, events:a.events, truncated:a.truncated, resume:a.resume, head:a.text.slice(0,3)}))
if (a.resume) {
  const b = expandRange(session, a.resume.seq, 2, { limit: 2000, offset: a.resume.offset })
  console.log('B', JSON.stringify({to:b.to, bytes:b.bytes, head:b.text.slice(0,3), len:b.text.length}))
}
