// 「记住」意图识别 + 提醒文本的确定性测试。不联网、不调用模型。
import assert from 'node:assert/strict'
import { rememberIntent, rememberExcerpt, rememberReminder } from '../src/memory/remember.js'

let passed = 0
const ok = (name, fn) => { fn(); passed++; console.log('PASS ' + name) }

ok('中文「记住」命中', () => assert.equal(rememberIntent('记住以后 github 也要改'), true))
ok('中文「以后都」命中', () => assert.equal(rememberIntent('以后都用 pnpm'), true))
ok('中文「别再」命中', () => assert.equal(rememberIntent('别再改我的配置文件'), true))
ok('英文 remember 命中', () => assert.equal(rememberIntent('remember to use tabs'), true))
ok('英文 from now on 命中', () => assert.equal(rememberIntent("from now on, don't touch main"), true))
ok('普通提问不命中', () => assert.equal(rememberIntent('这个函数是做什么的？'), false))
ok('空字符串不命中', () => assert.equal(rememberIntent(''), false))
ok('null 不命中', () => assert.equal(rememberIntent(null), false))
ok('摘录保留短句', () => assert.equal(rememberExcerpt('记住 用中文回答'), '记住 用中文回答'))
ok('摘录按上限截断并加省略号', () => {
  const out = rememberExcerpt('记'.repeat(300), 200)
  assert.equal(out.length, 201)
  assert.equal(out.endsWith('…'), true)
})
ok('摘录折叠换行', () => assert.equal(rememberExcerpt('记住\n\n要短'), '记住 要短'))
ok('提醒文本包含落盘要求与原话', () => {
  const out = rememberReminder('记住以后 github 也要改')
  assert.match(out, /memory_write/)
  assert.match(out, /长期记忆要求/)
  assert.match(out, /记住以后 github 也要改/)
})

console.log(`\n记住意图测试 ${passed} 条断言全部通过`)
