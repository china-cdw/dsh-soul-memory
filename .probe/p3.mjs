import { expandRange } from '../src/session-search.js'
const mk = (arr) => ({ eventAt: (s) => arr.find(e => e.seq === s) ?? null })

// E: `from` points at an empty event while offset>0 -> does offset leak to the next event?
const E = mk([{ seq: 1, data: { text: '   ' } }, { seq: 2, data: { text: 'ABCDEFGH' } }, { seq: 3, data: { text: 'ZZ' } }])
console.log('E from=1 offset=4:', JSON.stringify(expandRange(E, 1, 3, { limit: 100, offset: 4 })))

// F: offset far past the end of the only event
const F = mk([{ seq: 1, data: { text: 'ABCDEFGH' } }])
console.log('F offset=99:', JSON.stringify(expandRange(F, 1, 1, { limit: 100, offset: 99 })))

// G: offset on a CJK event, resumed offset math vs actual skipped bytes
const G = mk([{ seq: 1, data: { text: '中文中文中文' } }])
const g = expandRange(G, 1, 1, { limit: 3, offset: 3 })
console.log('G:', JSON.stringify(g))
if (g.resume) {
  const g2 = expandRange(G, g.resume.seq, g.resume.seq, { limit: 30, offset: g.resume.offset })
  console.log('G resume:', JSON.stringify(g2))
}
