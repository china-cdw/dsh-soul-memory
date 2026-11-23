// 会话级记忆开关的意图识别：用户当面说一句就能切档，不依赖模型记得调用工具。
//
// 这里最大的风险不是漏判，而是误判：一句「怎么关闭跨会话记忆？」或「不要关闭记忆」
// 只要命中关键词就把整个会话设成 off，用户看不到任何提示，后面整段对话都不落记忆。
// 所以每条规则命中后还要过三道否决：否定词、疑问句、以及「别记错」这类近义词。
const MODE_RULES = [
  { mode: 'off', re: /(关闭|关掉|停用|关死)(一下)?(跨会话)?(的)?记忆/ },
  { mode: 'off', re: /(这次|本会话|当前对话|这个对话)[^。！？]{0,8}(别记|不要记|不用记|不记)/ },
  { mode: 'normal', re: /(恢复|打开|开启|重新开启|重新打开)(一下)?(跨会话)?(的)?记忆/ },
]

const NEGATION = /(不要|不用|无需|不必|别|甭)/
const QUESTION_START = /^(怎么|如何|为什么|为啥|是否|能不能|可不可以|要不要|会不会|需不需要)/
const PUNCT = /[。！？!?；;\n]/

/** 命中位置所在分句的开头。 */
function clauseStart(text, index) {
  let start = 0
  for (let i = index - 1; i >= 0; i -= 1) {
    if (PUNCT.test(text[i])) { start = i + 1; break }
  }
  return start
}

/**
 * @param {string} text 用户这一轮的原文
 * @returns {'off'|'normal'|''} 空字符串表示不是切档意图
 */
export function sessionModeIntent(text) {
  const raw = String(text || '').trim()
  if (!raw) return ''
  for (const rule of MODE_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags.replace('g', ''))
    const match = re.exec(raw)
    if (!match) continue
    // 否定：「不要关闭记忆」「别恢复记忆」不是意图。
    const before = raw.slice(Math.max(0, match.index - 4), match.index)
    if (NEGATION.test(before)) continue
    // 「这次别记错 / 别记混」是在提醒你记准，不是「这次别记」。
    if (rule.mode === 'off' && /^[错混反]/.test(raw.slice(match.index + match[0].length))) continue
    // 疑问句：「怎么关闭记忆」「如何恢复记忆？」是在问，不是在要求。
    const clause = raw.slice(clauseStart(raw, match.index), match.index)
    if (QUESTION_START.test(clause)) continue
    if (/[？?]$/.test(raw) && !/(确认|确定|请|帮我|给我)/.test(raw)) continue
    return rule.mode
  }
  return ''
}
