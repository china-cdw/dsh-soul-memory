// 备份/搬家与回合日志的自检。
//
// 只测真正会出事的边界：导入默认不写盘、陌生格式整包拒绝、写前有快照、
// 日志只记有落点的轮次。图谱库不进备份是设计选择，这里也不测它。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeHome, suite, assert } from './_testkit.mjs'
import { backupsDir, exportBundle, importBundle, listBackups, readBundle, SCHEMA } from '../src/backup.js'
import { appendTurn, dayOf, readTurns } from '../src/turnlog.js'
import { memoryPath } from '../src/memory/util.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const home = await makeHome()
const s = suite('dsh-memory-backup')
let snapshot = null

try {
  await s.test('导出包含核心记忆与归档笔记', async () => {
    await mkdir(memoryPath('notes'), { recursive: true })
    await writeFile(memoryPath('MEMORY.md'), '# 核心记忆\n\n- 一条\n')
    await writeFile(memoryPath('CODING.md'), '# 编码规范（全局）\n\n## 规则\n\n- 规则一\n')
    await writeFile(memoryPath('notes', 'a.md'), '# 笔记 A\n')
    var exported = await exportBundle()
    assert(exported.files >= 3, `导出应包含至少 3 个文件，实际 ${exported.files}`)
    const listed = await listBackups()
    assert(listed.length >= 1, '导出后应能在列表里看到')
    const bundle = await readBundle(exported.path.split(/[\\/]/).pop())
    assert(bundle.schema === SCHEMA, 'schema 应为当前版本')
    assert(typeof bundle.files['MEMORY.md'] === 'string', '备包里应有 MEMORY.md 原文')
    snapshot = bundle
  })

  await s.test('陌生格式整包拒绝', async () => {
    await writeFile(join(backupsDir(), 'bad.json'), JSON.stringify({ schema: 'other@9', files: {} }))
    let rejected = false
    try { await readBundle('bad.json') } catch { rejected = true }
    assert(rejected, '陌生 schema 必须拒绝')
  })

  await s.test('路径穿越与坏 JSON 整包拒绝，不在记忆目录外落盘', async () => {
    let traversal = false
    try { await importBundle({ files: { 'notes/../evil.md': 'x' } }, { apply: true }) } catch { traversal = true }
    assert(traversal, '含 ../ 的文件名必须整包拒绝')
    let badJson = false
    await writeFile(join(backupsDir(), 'truncated.json'), '{')
    try { await readBundle('truncated.json') } catch { badJson = true }
    assert(badJson, '截断的 JSON 必须报错，不能当成空备份')
  })

  await s.test('预演不写盘，apply 才写并留快照', async () => {
    await writeFile(memoryPath('MEMORY.md'), '# 改过的\n')
    const dry = await importBundle(snapshot, { apply: false })
    assert(dry.changed.includes('MEMORY.md'), '预演应报告 MEMORY.md 会被覆盖')
    assert((await readFile(memoryPath('MEMORY.md'), 'utf8')).includes('改过的'), '预演不能写盘')
    const applied = await importBundle(snapshot, { apply: true })
    assert(applied.written >= 1, '应写入至少一个文件')
    assert((await readFile(memoryPath('MEMORY.md'), 'utf8')).includes('一条'), '导入后应恢复备份内容')
    const dirs = await readdir(backupsDir())
    assert(dirs.some(name => name.startsWith('pre-import-')), '导入前应有快照目录')
  })

  await s.test('回合日志只记有落点的轮次', async () => {
    const day = dayOf(Date.now()).key
    const before = (await readTurns({ days: 3 })).find(row => row.name === `${day}.md`)?.text ?? ''
    const wrote = await appendTurn({ ask: '把设置页的字数上限做成可编辑', nodes: 2, files: ['src/ui-routes.js'] })
    assert(wrote && wrote.line.includes('可编辑'), '应写入一行日志')
    assert(wrote.line.includes('src/ui-routes.js'), '日志应带产物路径')
    const skipped = await appendTurn({ ask: '闲聊', nodes: 0 })
    assert(skipped === null, '零节点的轮次不写日志')
    const after = (await readTurns({ days: 3 })).find(row => row.name === `${day}.md`)?.text ?? ''
    assert(after.length > before.length, '读回的日志应比之前长')
    assert(after.includes('→ 2 个节点'), '日志应写明节点数')
  })
} finally {
  s.finish()
  await home.cleanup()
}
