// 外部 AI 工具会话索引的自检。
//
// 只测真正会出事的边界：增量水位（不重复导入）、追加后只读新行、
// 外部来源能被单独检索出来。真实素材（QClaw/Claude Code）不参与测试。
import { mkdtemp, writeFile, appendFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/store.js'
import { listExternalSources, refreshExternal, externalCoverage } from '../src/external-sessions.js'
import { searchIndex } from '../src/span-index.js'
import { suite, assert } from './_testkit.mjs'

const s = suite('dsh-memory-external')
const dir = await mkdtemp(join(tmpdir(), 'dsh-ext-'))
const store = new Store(':memory:')
const scope = 'test-project'
const stores = [{
  agent: 'fake',
  dir: () => dir,
  match: (name) => name.endsWith('.jsonl'),
  session: (path) => path.split(/[\\/]/).pop().replace('.jsonl', ''),
}]

const turn = (role, text) => JSON.stringify({
  type: 'message',
  message: role === 'user' ? { role, content: text } : { role, content: [{ type: 'text', text }] },
}) + '\n'

try {
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'a.jsonl'), turn('user', '上次那台设备的串口是 COM3 吗') + turn('assistant', '是 COM3，波特率 115200'))

  await s.test('能发现转录文件', async () => {
    const found = listExternalSources({ stores })
    assert(found.length === 1, `应发现 1 个文件，实际 ${found.length}`)
    assert(found[0].session === 'fake:a', `session 应为 fake:a，实际 ${found[0].session}`)
  })

  await s.test('导入后进 span 表且能按来源统计', async () => {
    const result = refreshExternal(store, scope, { stores, budgetMs: 500 })
    assert(result.added === 2, `应导入 2 条，实际 ${result.added}`)
    const agents = externalCoverage(store, scope)
    assert(agents.fake === 1, `应统计到 1 个 fake 会话，实际 ${JSON.stringify(agents)}`)
  })

  await s.test('外部来源可单独检索，且不属于当前会话', async () => {
    const found = searchIndex(store, scope, '串口', { limit: 3, externalOnly: true })
    assert(found.spans.length >= 1, '应能检索到外部片段')
    assert(found.spans.every((row) => String(row.session).startsWith('fake:')), '结果应只来自外部会话')
    assert(found.spans[0].current === false, '外部片段不应被当成当前会话')
  })

  await s.test('重复导入不重复计数（水位生效）', async () => {
    const again = refreshExternal(store, scope, { stores, budgetMs: 500 })
    assert(again.added === 0, `第二次应导入 0 条，实际 ${again.added}`)
  })

  await s.test('追加新行后只导入新增', async () => {
    await appendFile(join(dir, 'a.jsonl'), turn('user', '换成 COM5 再试一次'))
    const more = refreshExternal(store, scope, { stores, budgetMs: 500 })
    assert(more.added === 1, `应只导入 1 条新行，实际 ${more.added}`)
    const found = searchIndex(store, scope, 'COM5', { limit: 3, externalOnly: true })
    assert(found.spans.length === 1, `应命中 1 条，实际 ${found.spans.length}`)
  })
  await s.test('超出上限的节点只退休，不硬删（还能 restore）', async () => {
    // 硬删 + secure_delete 会让「超出上限」变成不可恢复的记忆丢失；这里锁住可逆语义。
    const small = new Store(':memory:', { maxNodes: 2 })
    const nodes = Array.from({ length: 5 }, (_, i) => ({
      id: 'prune-' + i, kind: 'decision', claim: '裁剪测试节点 ' + i, seq: i,
    }))
    small.recordNodes('prune-scope', { nodes })
    const count = (state) => small.db.prepare("SELECT COUNT(*) n FROM node WHERE scope='prune-scope' AND state=?").get(state).n
    assert(count('active') === 2, `活跃节点应只剩 2 个，实际 ${count('active')}`)
    assert(count('retired') === 3, `被挤出的应退休而不是删除，实际 retired=${count('retired')}`)
    const restore = small.db.prepare("UPDATE node SET state='active' WHERE scope='prune-scope' AND state='retired'").run()
    assert(restore.changes === 3, '退休节点必须能恢复')
    small.db.close()
  })
} finally {
  // suite 的断言异常只记在 failures 里；不调 finish() 时进程仍然 exit 0，整套测试等于没看守。
  s.finish()
  await rm(dir, { recursive: true, force: true })
}
