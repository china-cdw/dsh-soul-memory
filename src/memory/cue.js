// 「记住」提醒的计数状态。
//
// 宿主的每个 model step 会组装两次上下文：preStep 里的 assemble()，以及请求前的
// refreshContext()。两者都会调用 systemPrompt.context 的 text()，而 assemble 那份文本
// 之后会被 refresh 的结果替换掉。所以计数不能在 text() 里扣：一个 step 会扣两次，
// 声明的「N 轮」实际只显示一半，多步回合还会在同一轮里烧完。
//
// 这里把计数放到 agent/pre-step（每个 step 一次）：advance() 推进一格，read() 只读。
// remaining 是「还要显示几个 model step」，show 给本轮用。

export function createRememberCues() {
  const cues = new Map()

  return {
    /** 记下一条要求；steps 默认为 2 个 model step（通常是本轮 + 下一轮）。 */
    arm(sid, text, at = 0, steps = 2) {
      cues.set(String(sid), { text, at, remaining: Math.max(1, steps), show: false })
    },
    /** 每个 step 调一次：还有额度就开显示并减一，额度用完就丢掉。 */
    advance(sid) {
      const key = String(sid)
      const cue = cues.get(key)
      if (!cue) return
      if (cue.remaining > 0) {
        cue.remaining -= 1
        cue.show = true
      } else {
        cues.delete(key)
      }
    },
    /** 纯读：有提醒返回 { text, at }，没有返回 null。 */
    read(sid) {
      const cue = cues.get(String(sid))
      return cue && cue.show ? { text: cue.text, at: cue.at } : null
    },
    clear(sid) {
      cues.delete(String(sid))
    },
    size() {
      return cues.size
    },
  }
}
