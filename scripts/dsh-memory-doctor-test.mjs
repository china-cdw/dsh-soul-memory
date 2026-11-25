// 记忆体检（memory_doctor）的自检。
//
// 重点不是「有没有输出」，而是每一类静默损坏都能被报出来：预算截断、索引与目录不一致、
// 日志坏行、备份打不开。体检的边界（测不到什么）也必须有输出，否则全绿会被当成一切正常。
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeHome, suite, assert, makeCtx, callTool, waitFor } from './_testkit.mjs'
import { memoryPath } from '../src/memory/util.js'
import { exportBundle } from '../src/backup.js'

const home = await makeHome()
const s = suite('dsh-memory-doctor')

try {
  await mkdir(memoryPath('notes'), { recursive: true })
  // 预算超 3000 字：注入会截断，体检必须把「尾部多少字没注入 + 全文在哪」说出来。
  await writeFile(memoryPath('MEMORY.md'), '# 核心\n\n' + '字'.repeat(3010))
  await writeFile(memoryPath('LESSONS.jsonl'), JSON.stringify({ fp: 'ok' }) + '\n{坏行\n')

  const { ctx, tools } = makeCtx()
  const { registerCoreMemory } = await import('../src/core-memory.js')
  registerCoreMemory(ctx, {})
  await waitFor(() => tools.has('memory_doctor'), { label: 'memory_doctor 注册' })
  // 等 bootstrap 的对账跑完，再人为制造不一致，避免被它当场修好。
  await new Promise((r) => setTimeout(r, 300))
  await writeFile(memoryPath('notes', 'a.md'), '---\ntitle: A\n---\n')
  await writeFile(memoryPath('notes', 'orphan.md'), '---\ntitle: 孤儿\n---\n')
  await writeFile(memoryPath('index.json'), JSON.stringify({ version: 1, notes: [
    { id: 'a', title: 'A' },
    { id: 'ghost', title: '索引有、文件没了' },
  ] }))

  let first = ''
  await s.test('坏项全部被报出', async () => {
    first = await callTool(tools, 'memory_doctor')
    assert(first.includes('需要'), '有坏项时汇总不能写「全部通过」：' + first.slice(0, 80))
    assert(first.includes('core.budget') && first.includes('尾部'), '应报核心记忆超预算并说明截断了多少')
    assert(first.includes('MEMORY.md'), '截断说明应给出全文位置')
    assert(first.includes('notes.index'), '应检查索引与 notes/ 的一致性')
    assert(first.includes('orphan') && first.includes('ghost'), '孤儿文件与缺失文件都要点名')
    assert(first.includes('lessons.parse'), '应逐行检查踩坑日志')
    assert(first.includes('backup.exists'), '没有备份要明确报出来')
    assert(first.includes('✅ redact.privateKey'), '应自检私钥整块打码是否生效');
    assert(first.includes('测不到'), '体检必须列出自己的盲区')
    assert(first.includes('⚠️ core.budget') || first.includes('⚠️ core'), '核心预算应为警告项')
  })

  await exportBundle()
  const second = await callTool(tools, 'memory_doctor')
  await s.test('导出备份后备份项变绿', async () => {
    assert(second.includes('✅ backup.readable'), '有可读备份时应通过：' + second.slice(0, 200))
  })

  // 修好索引后再检：同一套检查应能收敛，而不是永远红。
  await writeFile(memoryPath('index.json'), JSON.stringify({ version: 1, notes: [
    { id: 'a', title: 'A' },
    { id: 'orphan', title: '孤儿' },
  ] }))
  const third = await callTool(tools, 'memory_doctor')
  await s.test('修好后对应项转绿', async () => {
    assert(third.includes('✅ notes.index'), '索引对上后应通过：' + third.slice(0, 200))
  })

  await s.test('体检只读：索引坏了也不重建', async () => {
    const { readFile } = await import('node:fs/promises')
    await writeFile(memoryPath('index.json'), '{坏掉的 JSON')
    const fourth = await callTool(tools, 'memory_doctor')
    assert(fourth.includes('index.json 解析失败'), '损坏索引应被点名：' + fourth.slice(0, 200))
    const raw = await readFile(memoryPath('index.json'), 'utf8')
    assert(raw === '{坏掉的 JSON', '体检不该顺手重建索引')
  })

  await s.test('导入备份后立即重建索引，不用重启', async () => {
    await writeFile(memoryPath('index.json'), JSON.stringify({ version: 1, notes: [{ id: 'a', title: 'A' }] }))
    await writeFile(memoryPath('notes', 'imported.md'), '---\ntitle: 导入的\n---\n')
    const exp = await exportBundle()
    await rm(memoryPath('notes', 'imported.md'))
    const out = await callTool(tools, 'memory_backup', {
      action: 'import', file: exp.path.split(/[\\/]/).pop(), apply: true,
    })
    assert(out.includes('索引已按 notes/ 重建'), '导入后应重建索引：' + out.slice(0, 200))
    const doc = await callTool(tools, 'memory_doctor')
    assert(doc.includes('✅ notes.index'), '导入后索引应与目录一致：' + doc.slice(0, 300))
  })
} finally {
  s.finish()
  await home.cleanup()
}
