// 用户说「以后记住 / 记住怎么做」时，插件自己补一句确定性的提醒：
// 不依赖模型这一轮是否愿意调用 memory_write，先让它看见「这条要求必须落盘」。
const ZH = /(记住|记得|记一下|记下来|记着|以后都|以后别|以后要|以后不要|今后|往后|别再|不要再|永久保存|长期记住)/
const EN = /(remember|from now on|from here on|never again|don'?t forget|do not forget)/i

export function rememberIntent(text) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  return ZH.test(s) || EN.test(s)
}

export function rememberExcerpt(text, max = 200) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (s.length <= max) return s
  return s.slice(0, max) + '…'
}

export function rememberReminder(text) {
  return '[长期记忆要求] 用户本轮明确要求「记住」。先把它用 memory_write 存成自包含笔记'
    + '（必须长期稳定的再用 memory_core 写进核心记忆），存完再回答；不要只回一句「好的」。'
    + '原话：' + rememberExcerpt(text)
}
