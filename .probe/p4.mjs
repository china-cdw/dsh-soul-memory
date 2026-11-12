import { expandRange } from '../src/session-search.js'
const mk = (arr) => ({ eventAt: (s) => arr.find(e => e.seq === s) ?? null })
// event1 4 bytes, event2 = 数字序列，便于看出丢了哪几个字节
const seq2 = Array.from({ length: 60 }, (_, i) => String.fromCharCode(48 + (i % 10))).join('')
const S = mk([{ seq: 1, data: { text: 'AAAA' } }, { seq: 2, data: { text: seq2 } }])
const a = expandRange(S, 1, 2, { limit: 20, offset: 4 })
console.log('第一次: text=', JSON.stringify(a.text), 'resume=', JSON.stringify(a.resume), 'to=', a.to)
const b = expandRange(S, a.resume.seq, a.resume.seq, { limit: 20, offset: a.resume.offset })
console.log('续读  : text=', JSON.stringify(b.text))
console.log('正确应续读 event2 第 20 字节起:', JSON.stringify(seq2.slice(20, 40)))
console.log('实际丢了:', JSON.stringify(seq2.slice(20, 24)), '(resume.offset 多了 4)')
