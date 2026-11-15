// 备份与搬家。
//
// 只做一件事：把「记忆目录里真正会被人读懂的东西」打成一个 JSON，原样带上，原样放回。
// 刻意不碰 SQLite 图谱库——那是几万行的派生数据，搬过去也未必能打开，而它随时可以从
// markdown 与对话里重建；把不可重建的那部分保住，才是备份的意义。
//
// 安全边界：
// - 导出只读已知文件名，不遍历整个目录（避免把 token、临时文件、别的插件的东西带走）；
// - 导入默认 dry-run，只报告会写什么，不落盘；
// - 真正导入前先把现存文件复制到 pre-import 快照目录；中途失败时已有文件不会被半覆盖；
// - 包内 schema 不认就整包拒绝，不做「尽力而为」的猜测。
import { copyFile, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, memoryPath } from './memory/util.js'

export const SCHEMA = 'dsh-soul-memory/backup@1'
const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_FILES = 2000

/** 顶层已知文件：顺序固定，备份文件因此可 diff。 */
const SINGLE = ['MEMORY.md', 'CODING.md', 'CODING.pending.json', 'PERSONA.md', 'LESSONS.jsonl', 'SOUL-UI.json', 'DREAMING.json']

export function backupsDir() {
  return memoryPath('backups')
}

function stamp(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

/** 读一个已知文件；不存在返回 null，其它读错误照实抛。 */
async function readKnown(name) {
  try {
    const text = await readFile(memoryPath(name), 'utf8')
    return Buffer.byteLength(text) <= MAX_FILE_BYTES ? text : null
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function collectFiles() {
  const files = {}
  for (const name of SINGLE) {
    const text = await readKnown(name)
    if (text !== null) files[name] = text
  }
  let names = []
  try {
    names = await readdir(memoryPath('notes'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  names.sort()
  for (const name of names.slice(0, MAX_FILES)) {
    if (!name.endsWith('.md')) continue
    const text = await readKnown(join('notes', name))
    if (text !== null) files[`notes/${name}`] = text
  }
  return files
}

/** 导出：写一份带时间戳的 JSON，返回路径与规模，不打印内容。 */
export async function exportBundle() {
  const files = await collectFiles()
  const bundle = { schema: SCHEMA, createdAt: new Date().toISOString(), files }
  const body = JSON.stringify(bundle, null, 2)
  await mkdir(backupsDir(), { recursive: true })
  const path = join(backupsDir(), `${stamp()}.json`)
  await atomicWrite(path, body)
  return { path, files: Object.keys(files).length, bytes: Buffer.byteLength(body), createdAt: bundle.createdAt }
}

/** 列出已有备份，新→旧。 */
export async function listBackups({ limit = 20 } = {}) {
  let names = []
  try {
    names = await readdir(backupsDir())
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  const rows = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = join(backupsDir(), name)
    try {
      const info = await stat(full)
      rows.push({ name, bytes: info.size, mtime: info.mtime.toISOString() })
    } catch { /* 列举期间被删掉，跳过 */ }
  }
  rows.sort((a, b) => b.mtime.localeCompare(a.mtime))
  return rows.slice(0, limit)
}

export async function readBundle(name) {
  const raw = String(name ?? '')
  // The name is joined onto the backup directory, so a path separator or a drive letter
  // would silently leave it — report that instead of failing later with ENOENT on a
  // mangled name, which read like "the file is missing".
  if (/[\\/:]/.test(raw)) throw new Error('file 只能是备份目录里的文件名（用 action=list 看有哪些），不是路径')
  const safe = raw
  if (!safe.endsWith('.json')) throw new Error('备份文件名必须以 .json 结尾')
  const text = await readFile(join(backupsDir(), safe), 'utf8')
  const parsed = JSON.parse(text)
  if (parsed?.schema !== SCHEMA) throw new Error(`不认识的备份格式：${String(parsed?.schema)}`)
  if (!parsed.files || typeof parsed.files !== 'object') throw new Error('备份里没有文件清单')
  return parsed
}

/**
 * 导入。dry-run 只对比「新增 / 覆盖 / 未变」，apply 才写。
 * 写之前整目录快照到 pre-import-<stamp>，用文件名做版本，覆盖错了能翻回来。
 */
const SAFE_NAME = /^(?:MEMORY\.md|CODING\.md|CODING\.pending\.json|PERSONA\.md|LESSONS\.jsonl|SOUL-UI\.json|DREAMING\.json|notes\/[^\\/]+\.md)$/

export async function importBundle(bundle, { apply = false } = {}) {
  const names = Object.keys(bundle.files ?? {})
  const unsafe = names.filter(name => !SAFE_NAME.test(name))
  if (unsafe.length) throw new Error(`备份里含不允许的文件名（会写到记忆目录之外）：${unsafe[0]}`)
  const incoming = Object.entries(bundle.files).filter(([, text]) => typeof text === 'string')
  const current = await collectFiles()
  const added = []
  const changed = []
  const same = []
  for (const [name, text] of incoming) {
    if (!(name in current)) added.push(name)
    else if (current[name] !== text) changed.push(name)
    else same.push(name)
  }
  const report = { added, changed, same: same.length, total: incoming.length, apply: Boolean(apply) }
  if (!apply) return report
  if (!incoming.length) return { ...report, written: 0 }

  const snapshot = join(backupsDir(), `pre-import-${stamp()}`)
  await mkdir(snapshot, { recursive: true })
  for (const name of [...added, ...changed]) {
    const existing = current[name]
    if (existing === undefined) continue
    const target = join(snapshot, name.replace(/^notes\//, 'notes-'))
    await atomicWrite(target, existing).catch(() => {})
    await copyFile(memoryPath(name), target).catch(() => {})
  }

  let written = 0
  for (const [name, text] of incoming) {
    if (same.length && current[name] === text) continue
    const path = memoryPath(name)
    await mkdir(join(path, '..'), { recursive: true })
    await atomicWrite(path, text)
    written++
  }
  return { ...report, written, snapshot }
}
