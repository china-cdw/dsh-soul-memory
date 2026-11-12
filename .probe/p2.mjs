import { expandRange } from '../src/session-search.js'
const mk = (arr) => ({ eventAt: (s) => arr.find(e => e.seq === s) ?? null })

// case A: offset skips whole event1, event2 clipped -> resumeBase stale?
const A = mk([{seq:1,data:{text:'AAAA'}},{seq:2,data:{text:'X'.repeat(3000)}},{seq:3,data:{text:'CCC'}}])
const a = expandRange(A, 1, 3, { limit: 100, offset: 4 })
console.log('A: to=',a.to,'events=',a.events,'resume=',JSON.stringify(a.resume),'len=',a.text.length)
const a2 = expandRange(A, a.resume.seq, a.resume.seq, { limit: 100, offset: a.resume.offset })
console.log('A resume replay: len=', a2.text.length, 'starts=', JSON.stringify(a2.text.slice(0,10)), 'to=',a2.to)

// case B: nonzero budget too small for first char
const B = mk([{seq:1,data:{text:'中文'}},{seq:2,data:{text:'x'}}])
const b = expandRange(B, 1, 2, { limit: 1 })
console.log('B:', JSON.stringify(b))

// case C: start=0 zero budget
const c = expandRange(mk([{seq:0,data:{text:'hi'}}]), 0, 0, { limit: 0 })
console.log('C:', JSON.stringify(c))

// case D: offset exactly consumes all events
const D = mk([{seq:1,data:{text:'AAAA'}}])
console.log('D:', JSON.stringify(expandRange(D, 1, 1, { limit: 100, offset: 4 })))
