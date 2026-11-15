/**
 * 记忆分级（tier）与回收（GC）的确定性判据。
 *
 * 分三层，但依据不是「重不重要」这种主观判断——kind 本身已经编码了语义：
 * - high：约束（constraint）与钉住的节点。方法论 / 边界，错了就是事故，永不回收。
 * - medium：决策（decision）与进度（progress）。项目状态与取舍，过时了也值得留一阵。
 * - low：产物（artifact）、索引（reference）与其他。可从代码、文件、日志重建。
 *
 * 这一层只做「判据」，不碰数据库：store 与工具层各自决定怎么用（见 core-memory 的 memory_tier）。
 */

export const TIERS = ['high', 'medium', 'low']

export const TIER_LABELS = { high: '🔴 高', medium: '🟡 中', low: '🟢 低' }

/** kind → tier 的映射。新增 kind 时默认落 low，宁可少回收也不错收。 */
const HIGH_KINDS = new Set(['constraint'])
const MEDIUM_KINDS = new Set(['decision', 'progress'])

/** 默认回收门槛：三个月没人要，才从 low 层回收（对应 KNOWLEDGE_BASE 的「三个月无复用价值即丢弃」）。 */
export const GC_DEFAULTS = { minAgeDays: 90, maxImportance: 3, requireZeroHits: true }

/**
 * 单个节点的分级。
 * @param {{kind?: string, pin?: boolean}} node
 * @returns {'high'|'medium'|'low'}
 */
export function tierOf(node) {
  if (!node) return 'low'
  if (node.pin) return 'high'
  if (HIGH_KINDS.has(node.kind)) return 'high'
  if (MEDIUM_KINDS.has(node.kind)) return 'medium'
  return 'low'
}

/**
 * 各层条数。
 * @param {Array<object>} nodes
 * @returns {{high: number, medium: number, low: number}}
 */
export function tierCounts(nodes) {
  const counts = { high: 0, medium: 0, low: 0 }
  for (const node of Array.isArray(nodes) ? nodes : []) counts[tierOf(node)] += 1
  return counts
}

/**
 * 回收候选：只从 low 层挑，且必须同时满足四个「没人再要它」的信号。
 *
 * 比 graph-memory 的 periphery() 更保守，因为这里的动作是回收（虽然可逆）：
 * - 时间 90 天而不是 7 天：low 层里也可能躺着还没被引用的产物；
 * - 不看激活值 A：A 是「多久没被想到」，不等于「不值得留」；
 * - 不看度数：low 层节点的边本来就稀疏，度数不能当错杀的理由。
 *
 * @param {Array<object>} nodes memoryView().list 的条目
 * @param {{minAgeDays?: number, maxImportance?: number, requireZeroHits?: boolean}} [opts]
 */
export function collectionCandidates(nodes, opts = {}) {
  const { minAgeDays = GC_DEFAULTS.minAgeDays, maxImportance = GC_DEFAULTS.maxImportance, requireZeroHits = GC_DEFAULTS.requireZeroHits } = opts
  return (Array.isArray(nodes) ? nodes : []).filter(node => {
    if (!node || tierOf(node) !== 'low') return false
    if (node.pin) return false
    if (Number(node.importance ?? 2) > maxImportance) return false
    if (requireZeroHits && (Number(node.hits) || 0) > 0) return false
    return Number(node.ageDays) >= minAgeDays
  })
}

/**
 * 一行分级摘要，给 memory_brief 用。
 * @param {{high: number, medium: number, low: number}} counts
 * @param {number} [gcCandidates]
 */
export function tierSummary(counts, gcCandidates) {
  const parts = TIERS.map(t => TIER_LABELS[t] + ' ' + (counts[t] ?? 0))
  let line = parts.join(' / ')
  if (Number.isFinite(gcCandidates)) line += '（可回收 ' + gcCandidates + ' 条）'
  return line
}
