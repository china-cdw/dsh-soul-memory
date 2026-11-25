// 回合日志：把「这一轮做了什么」压成一行，按天落盘。
//
// 为什么不用模型判断：每轮调一次模型的代价，比它省下来的记忆更贵。这里只做规则拼接——
// 用户要了什么、写了几个节点、产物落在哪——纯成本是几行 markdown，收益是隔几天回来还能
// 知道那天在干什么。值得记的细节已经在图谱里；这里记的是时间线。
//
// 不放进 notes/：归档笔记是「一条判断」，这里是一天的流水，混在一起会让 memory_list
// 变吵。单独目录，单独工具读。
import { appendFile, mkdir, readdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { memoryPath } from './memory/util.js'
import { stripPrivate } from './memory/private.js'

const MAX_LINE = 400

function pad(n) {
  return String(n).padStart(2, '0')
}

export function dayOf(now = Date.now()) {
  const d = new Date(now)
  return { key: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` }
}

function clip(text, limit = 90) {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim()
  return flat.length > limit ? flat.slice(0, limit) + '…' : flat
}

/**
 * 拼一行并追加。`ask` 是用户这一轮的原话（截断），`files` 是本轮写过的产物路径。
 * 没有节点的一轮（闲聊、纯问答）不写：时间线只记有落点的轮次。
 */
export async function appendTurn({ ask = '', action = '', nodes = 0, kinds = [], files = [], now = Date.now() } = {}) {
  if (!nodes || nodes <= 0) return null
  // 第二道防线：写盘前再摘一次 <private>。上游（index.js）已经传脱敏后的 ask，
  // 但回合日志是数据外流面（设置页会读），不能只依赖调用方记得脱敏。
  ask = stripPrivate(String(ask ?? '')).text
  action = stripPrivate(String(action ?? '')).text
  files = (Array.isArray(files) ? files : []).map(file => stripPrivate(String(file ?? '')).text)
  const { key, time } = dayOf(now)
  const parts = [`- ${time}`]
  if (ask) parts.push(`「${clip(ask)}」`)
  if (action) parts.push(action)
  parts.push(`→ ${nodes} 个节点`)
  if (kinds.length) parts.push(`（${kinds.slice(0, 4).join(' / ')}）`)
  if (files.length) parts.push(`产物：${files.slice(0, 3).map(file => clip(file, 60)).join('、')}`)
  let line = parts.join(' ') + '\n'
  if (line.length > MAX_LINE) line = line.slice(0, MAX_LINE - 1) + '…\n'
  const path = memoryPath('turns', `${key}.md`)
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, line)
  return { path, line }
}

/** 最近 N 天的日志，新→旧，单文件截断在 8KB 内。 */
export async function readTurns({ days = 7 } = {}) {
  let names = []
  try {
    names = await readdir(memoryPath('turns'))
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
  names.sort().reverse()
  const picked = names.slice(0, Math.max(1, Math.min(60, days))).filter(name => name.endsWith('.md'))
  const out = []
  for (const name of picked) {
    const path = join(memoryPath('turns'), name)
    let text = ''
    try {
      text = await readFile(path, 'utf8')
    } catch { continue }
    out.push({ name, text: text.length > 8192 ? text.slice(0, 8192) + '\n…（已截断）' : text })
  }
  return out
}
