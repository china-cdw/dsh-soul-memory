// 闲时整理（dreaming）：把近期决策 / 纠错 / 重复进度聚成 digest 笔记。
//
// 设计边界（刻意保守）：
// - 默认关闭，开启是用户显式选择（设置项或 memory_dreaming action=on）；
// - 只新增 digest 笔记，不删、不改既有记忆；
// - 手动 run 默认 dry-run（只列候选），写盘需要 apply=true；
// - 有冷却时间与单次条数上限，避免「记一堆低价值摘要」把记忆库冲淡。
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { memoryPath } from './memory/util.js'
import { injected } from './util.js'

export const DREAMING_DEFAULTS = {
  enabled: false,
  idleDelaySeconds: 120,
  minIntervalMinutes: 180,
  maxNotes: 3,
  minCluster: 2,
}

/** <memory>/DREAMING.json：运行态（用户开关、上次整理时间与结果）。 */
export function dreamingStatePath() {
  return memoryPath('DREAMING.json')
}

export async function readDreamingState() {
  try {
    const raw = await readFile(dreamingStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { ...DREAMING_DEFAULTS, configured: false }
    return {
      ...DREAMING_DEFAULTS,
      ...parsed,
      // configured 区分「用户显式开/关」与「沿用设置项默认值」。
      configured: Object.prototype.hasOwnProperty.call(parsed, 'enabled'),
    }
  } catch (e) {
    if (e && e.code !== 'ENOENT') {
      console.error('dsh-x-memory: 读取 DREAMING.json 失败，按默认值处理：' + ((e && e.message) || e))
    }
    return { ...DREAMING_DEFAULTS, configured: false }
  }
}

export async function writeDreamingState(patch) {
  const current = await readDreamingState()
  const next = { ...current, ...(patch && typeof patch === 'object' ? patch : {}) }
  const target = dreamingStatePath()
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, JSON.stringify(next, null, 2) + '\n', 'utf8')
  return next
}

const CJK = /[\u4e00-\u9fff]/

/** 归一化后的可比文本：小写、压空白、截断，避免长正文把相似度算歪。 */
export function normText(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 240)
}

/** 中文按 bigram、拉丁按词，做成词集；用于判断两条节点是不是在说同一件事。 */
export function tokenSet(text) {
  const s = normText(text)
  const tokens = new Set()
  const latin = s.match(/[a-z0-9][a-z0-9_.:-]{1,}/g) || []
  for (const word of latin) tokens.add(word)
  let cjk = ''
  for (const ch of s) {
    if (CJK.test(ch)) cjk += ch
    else if (cjk) {
      if (cjk.length === 1) tokens.add(cjk)
      for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk.slice(i, i + 2))
      cjk = ''
    }
  }
  if (cjk) {
    if (cjk.length === 1) tokens.add(cjk)
    for (let i = 0; i + 1 < cjk.length; i++) tokens.add(cjk.slice(i, i + 2))
  }
  return tokens
}

export function similarity(a, b) {
  const A = a instanceof Set ? a : tokenSet(a)
  const B = b instanceof Set ? b : tokenSet(b)
  if (!A.size || !B.size) return 0
  let shared = 0
  for (const t of A) if (B.has(t)) shared++
  return shared / (A.size + B.size - shared)
}

/** 只挑值得沉淀的节点：决策、约束、进度；跳过宿主注入文本与过短内容。 */
export function dreamCandidates(nodes) {
  const out = []
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || typeof node !== 'object') continue
    const kind = String(node.kind ?? '')
    if (!['decision', 'constraint', 'progress'].includes(kind)) continue
    const text = String(node.text ?? node.label ?? '').trim()
    if (text.length < 8 || injected(text)) continue
    out.push({
      id: node.id != null ? String(node.id) : null,
      kind,
      text,
      seq: Number.isFinite(node.seq) ? Number(node.seq) : null,
      sessionId: node.sessionId != null ? String(node.sessionId) : null,
      why: typeof node.why === 'string' ? node.why : '',
    })
  }
  return out
}

/**
 * 把候选节点聚成 digest 草稿（纯函数，便于测试）。
 * 同一主题至少 minCluster 条才成稿；孤立的 decision 带 why 时也允许成稿。
 */
export function pickDigests(nodes, { maxNotes = 3, minCluster = 2 } = {}) {
  const items = dreamCandidates(nodes)
  const clusters = []
  for (const item of items) {
    const tokens = tokenSet(item.text)
    let target = null
    for (const cluster of clusters) {
      if (similarity(tokens, cluster.tokens) >= 0.5) { target = cluster; break }
    }
    if (target) {
      target.items.push(item)
      for (const t of tokens) target.tokens.add(t)
    } else {
      clusters.push({ tokens, items: [item] })
    }
  }
  const drafts = []
  for (const cluster of clusters) {
    const solo = cluster.items.length === 1
    const decisionWithWhy = solo && cluster.items[0].kind === 'decision' && cluster.items[0].why
    if (solo && !decisionWithWhy) continue
    if (!solo && cluster.items.length < Math.max(2, minCluster)) continue
    const sorted = [...cluster.items].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
    const first = sorted[0]
    const latest = sorted[sorted.length - 1]
    const lines = sorted.map((it) => '- [' + it.kind + '] ' + it.text + (it.seq != null ? '（seq ' + it.seq + '）' : ''))
    const whyLines = sorted.filter((it) => it.why).map((it) => '- ' + it.why)
    const content = ['闲时整理（dreaming）自动聚合，不是新结论；原文可用 soul_expand 回看。', '', ...lines,
      ...(whyLines.length ? ['', '为什么：', ...whyLines] : [])].join('\n')
    drafts.push({
      title: (first.text.length > 60 ? first.text.slice(0, 57) + '…' : first.text) + '（dream 聚合 ' + sorted.length + ' 条）',
      content,
      tags: ['dream', first.kind],
      session: latest.sessionId || null,
      seq: latest.seq,
      events: sorted.length,
    })
  }
  drafts.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
  return drafts.slice(0, Math.max(1, maxNotes))
}
