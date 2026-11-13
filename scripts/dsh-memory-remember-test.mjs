// 「记住」意图识别、原话窗口与提醒计数的确定性测试。不联网、不调用模型。
import assert from 'node:assert/strict'
import { rememberIntent, rememberMatch, rememberExcerpt, rememberReminder } from '../src/memory/remember.js'
import { createRememberCues } from '../src/memory/cue.js'

let passed = 0
const ok = (name, fn) => { fn(); passed++; console.log('PASS ' + name) }

// ---- 命中的说法 ---------------------------------------------------------
ok('中文「记住」命中', () => assert.equal(rememberIntent('记住以后 github 也要改'), true))
ok('中文「以后都」命中', () => assert.equal(rememberIntent('以后都用 pnpm'), true))
ok('中文「以后用」命中', () => assert.equal(rememberIntent('以后用 pnpm 装依赖'), true))
ok('中文「以后默认」命中', () => assert.equal(rememberIntent('以后默认用 tab 缩进'), true))
ok('中文「以后别再」命中', () => assert.equal(rememberIntent('以后别再改我的配置文件'), true))
ok('中文「记得以后」命中', () => assert.equal(rememberIntent('记得以后先跑测试'), true))
ok('英文 remember 祈使命中', () => assert.equal(rememberIntent('remember to use tabs'), true))
ok('英文 from now on 命中', () => assert.equal(rememberIntent("from now on, don't touch main"), true))
ok('英文 keep in mind 命中', () => assert.equal(rememberIntent('keep in mind the build is slow'), true))

// ---- 不该命中的说法 -----------------------------------------------------
ok('问句「还记得…吗」不命中', () => assert.equal(rememberIntent('你还记得上次的配置吗'), false))
ok('否定「我不记得了」不命中', () => assert.equal(rememberIntent('我不记得了'), false))
ok('一次性「别再报错了」不命中', () => assert.equal(rememberIntent('别再报错了'), false))
ok('英文 don\'t remember 不命中', () => assert.equal(rememberIntent("I don't remember why"), false))
ok('英文 Do you remember 不命中', () => assert.equal(rememberIntent('Do you remember the schema?'), false))
ok('代码标识符 rememberMe 不命中', () => assert.equal(rememberIntent('代码里有 rememberMe 字段'), false))
ok('普通提问不命中', () => assert.equal(rememberIntent('这个函数是做什么的？'), false))
ok('空字符串不命中', () => assert.equal(rememberIntent(''), false))
ok('null 不命中', () => assert.equal(rememberIntent(null), false))

// ---- 原话窗口 -----------------------------------------------------------
ok('摘录保留短句', () => assert.equal(rememberExcerpt('记住 用中文回答'), '记住 用中文回答'))
ok('摘录按上限截断并加省略号', () => {
  const out = rememberExcerpt('记'.repeat(300), 200)
  assert.equal(out.length, 201)
  assert.equal(out.endsWith('…'), true)
})
ok('长消息取命中位置附近而不是开头', () => {
  const text = 'x'.repeat(300) + ' 记住 用中文 ' + 'y'.repeat(300)
  const hit = rememberMatch(text)
  assert.equal(hit !== null, true)
  const out = rememberExcerpt(text, 200, hit.index)
  assert.match(out, /记住 用中文/)
  assert.equal(out.startsWith('…'), true)
})
ok('摘录折叠换行', () => assert.equal(rememberExcerpt('记住\n\n要短'), '记住 要短'))

// ---- 提醒文本 -----------------------------------------------------------
ok('提醒文本包含落盘要求与原话', () => {
  const out = rememberReminder('记住以后 github 也要改')
  assert.match(out, /memory_write/)
  assert.match(out, /长期记忆要求/)
  assert.match(out, /记住以后 github 也要改/)
})
ok('提醒文本要求不重复写', () => assert.match(rememberReminder('记住 x'), /不要重复存/))

// ---- 计数：每个 step 只推进一次 -----------------------------------------
ok('arm 之后（assemble 那次）还没到显示时机', () => {
  const cues = createRememberCues()
  cues.arm('s1', '记住 x', 3)
  assert.equal(cues.read('s1'), null)
})
ok('advance 之后开始显示，且带上原话位置', () => {
  const cues = createRememberCues()
  cues.arm('s1', '记住 x', 3)
  cues.advance('s1')
  assert.deepEqual(cues.read('s1'), { text: '记住 x', at: 3 })
})
ok('同一 step 读两次不扣额度（assemble + refresh）', () => {
  const cues = createRememberCues()
  cues.arm('s1', '记住 x')
  cues.advance('s1')
  assert.notEqual(cues.read('s1'), null)
  assert.notEqual(cues.read('s1'), null)
})
ok('第二个 step 仍显示', () => {
  const cues = createRememberCues()
  cues.arm('s1', '记住 x')
  cues.advance('s1')
  cues.advance('s1')
  assert.notEqual(cues.read('s1'), null)
})
ok('第三个 step 开始消失', () => {
  const cues = createRememberCues()
  cues.arm('s1', '记住 x')
  cues.advance('s1')
  cues.advance('s1')
  cues.advance('s1')
  assert.equal(cues.read('s1'), null)
  assert.equal(cues.size(), 0)
})
ok('clear 清掉会话的提醒', () => {
  const cues = createRememberCues()
  cues.arm('s1', '记住 x')
  cues.advance('s1')
  cues.clear('s1')
  assert.equal(cues.read('s1'), null)
})

console.log(`\n记住意图测试 ${passed} 条断言全部通过`)
