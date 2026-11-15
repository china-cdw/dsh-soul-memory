// dsh-soul-memory — 灵魂记忆（浏览器端）
//
// 一个设置页 + 两种常驻形态：
//   设置 → 灵魂记忆        待批区 / 规则 / 称呼与风格 / 记忆分级
//   输入框下方提示条       displayMode=inline 时，有待批规则才出现
//   右侧面板 / 居中浮层     displayMode=sidebar / overlay 时常驻（shell.overlay）
//
// 数据走同源 fetch（Host 用 webServer 注册了 /dsh-soul-memory/*），
// 与 agent 工具共用同一套文件与校验，不存在第二份状态。
window.__ModuleLoader__.load({
  id: 'dsh-soul-memory',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useCallback, useRef, useMemo } = React

    // ---------------------------------------------------------------- 样式
    // 只用宿主主题 token：跟随浅色/深色自动换色，不写死颜色。
    const STYLE_ID = 'dsh-soul-memory-style'
    const CSS = `
.dsm-root{--dsm-gap:12px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary)}
.dsm-page{display:flex;flex-direction:column;gap:18px;padding:24px 28px 40px;max-width:920px}
.dsm-h1{margin:0;font-size:18px;font-weight:600;letter-spacing:.2px}
.dsm-sub{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px}
.dsm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;flex-wrap:wrap}
.dsm-tabs{display:flex;flex-wrap:wrap;gap:4px;padding:3px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);align-self:flex-start}
.dsm-tab{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;padding:6px 12px;border-radius:var(--dsw-radius-sm);cursor:pointer}
.dsm-tab[data-active="1"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgba(0,0,0,.08)}
.dsm-card{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);padding:16px 20px}
.dsm-card h3{margin:0 0 6px;font-size:14px;font-weight:600}
.dsm-card p.dsm-hint{margin:0 0 12px;color:var(--dsw-alias-label-tertiary);font-size:12px}
/* 三个形态是单选组：纵向排列，说明不会被 200px 窄列压成三行，也不会出现 2+1 的孤行。 */
.dsm-modes{display:flex;flex-direction:column;gap:8px}
.dsm-mode{display:flex;gap:10px;align-items:flex-start;text-align:left;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);padding:12px;cursor:pointer;font:inherit;color:inherit}
.dsm-mode[data-active="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsm-mode-dot{flex:0 0 14px;width:14px;height:14px;margin-top:3px;border-radius:50%;border:1.5px solid var(--dsw-alias-border-l2)}
.dsm-mode[data-active="1"] .dsm-mode-dot{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-brand-primary);box-shadow:inset 0 0 0 3px var(--dsw-alias-bg-base)}
.dsm-mode b{display:block;font-size:12px;font-weight:600}
/* :not([class]) 只选描述行，别把 dsm-mode-dot 的 margin/颜色一起改了。 */
.dsm-mode span:not([class]){display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px}
.dsm-mode-cost{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:3px}
.dsm-count{display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;margin-left:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:500;vertical-align:1px}
.dsm-list{display:flex;flex-direction:column;gap:10px;margin-top:14px}
.dsm-item{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:12px 16px;background:var(--dsw-alias-bg-base)}
.dsm-item-top{display:flex;gap:10px;align-items:flex-start}
.dsm-item-text{flex:1;min-width:0;font-size:12px;white-space:pre-wrap;word-break:break-word}
.dsm-meta{margin-top:6px;color:var(--dsw-alias-label-secondary);font-size:11px;display:flex;flex-wrap:wrap;gap:10px;overflow-wrap:anywhere}
.dsm-meta em{font-style:normal;color:var(--dsw-alias-label-primary)}
.dsm-row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.dsm-btn{border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;height:28px;box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;padding:0 12px;border-radius:var(--dsw-radius-sm);cursor:pointer}
.dsm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsm-btn[data-tone="primary"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-on-color)}
.dsm-btn[data-tone="primary"]:hover{background:var(--dsw-alias-button-primary-hover)}
.dsm-btn[data-tone="danger"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l3)}
.dsm-btn[data-tone="ghost"]{border-color:transparent;background:transparent;color:var(--dsw-alias-label-secondary)}
.dsm-btn:disabled{opacity:.55;cursor:default;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);border-color:transparent}
.dsm-empty{color:var(--dsw-alias-label-tertiary);font-size:12px;padding:18px;text-align:center;border:1px dashed var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md)}
.dsm-input,.dsm-textarea{width:100%;box-sizing:border-box;font:inherit;font-size:12px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);padding:5px 10px}
.dsm-input{height:28px}
.dsm-input:focus,.dsm-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary)}
.dsm-textarea{min-height:96px;resize:vertical;line-height:1.6}
.dsm-label{display:block;font-size:12px;font-weight:600;margin-bottom:6px}
.dsm-field{display:flex;flex-direction:column;gap:6px;margin-bottom:16px}
.dsm-field-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-modal-mask{position:fixed;inset:0;z-index:70;display:flex;align-items:center;justify-content:center;padding:24px;background:var(--dsw-alias-bg-mask-1)}
.dsm-modal{width:min(720px,100%);max-height:min(82vh,760px);overflow:auto;padding:20px 22px;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm,8px);box-shadow:0 18px 48px rgba(0,0,0,.24)}
.dsm-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:16px}
.dsm-modal-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dsm-modal-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.dsm-presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}
.dsm-preset{text-align:left;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);padding:10px 12px;cursor:pointer;font:inherit;color:inherit}
.dsm-preset[data-active="1"]{border-color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-interactive-bg-hover-accent)}
.dsm-preset b{display:block;font-size:12px}
.dsm-preset span{display:block;color:var(--dsw-alias-label-tertiary);font-size:11px;margin-top:2px}
.dsm-tiers{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}
.dsm-tier{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:12px 14px;background:var(--dsw-alias-bg-base)}
.dsm-tier b{display:block;font-size:18px;font-weight:600;line-height:1.2}
.dsm-tier span{font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsm-rules{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);padding:12px 14px;margin:0;max-height:420px;overflow:auto}
.dsm-meter{height:6px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;margin:8px 0 10px}
.dsm-budget{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:8px 0}
.dsm-budget-input{width:88px;padding:4px 8px;font-size:12px}.dsm-meter-fill{height:100%;border-radius:999px;background:var(--dsw-alias-accent-1,#4c8dff);transition:width .2s ease}
.dsm-meter-fill[data-warn="1"]{background:var(--dsw-alias-state-warning-primary)}
.dsm-mute{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap}
.dsm-seg{display:inline-flex;padding:3px;gap:3px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l3)}
    .dsm-seg-btn{appearance:none;border:0;background:transparent;color:inherit;font:inherit;font-size:12px;padding:5px 14px;border-radius:var(--dsw-radius-sm);cursor:pointer;opacity:.7}
    .dsm-seg-btn[data-active="1"]{background:var(--dsw-alias-bg-base,#fff);opacity:1;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.08)}
    .dsm-seg-btn:disabled{opacity:.45;cursor:default}
    .dsm-mute-label{font-size:12px;color:var(--dsw-alias-label-tertiary);margin-right:2px}
.dsm-health{border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-base);padding:12px;margin-bottom:14px}
.dsm-health-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:8px}
.dsm-health-cell{display:flex;flex-direction:column;align-items:flex-start;gap:2px;padding:8px 10px;border-radius:var(--dsw-radius-md);border:1px solid transparent;background:transparent;cursor:pointer;text-align:left;font:inherit;color:inherit}
.dsm-health-cell:disabled{cursor:default}
.dsm-health-cell:not(:disabled):hover{border-color:var(--dsw-alias-border-l3)}
.dsm-health-cell b{font-size:18px;font-weight:600;line-height:1.2}
.dsm-health-cell span{font-size:11px;color:var(--dsw-alias-label-secondary)}
.dsm-health-cell em{font-size:11px;font-style:normal;color:var(--dsw-alias-label-tertiary)}
.dsm-health-cell[data-warn="1"] b{color:var(--dsw-alias-state-warning-primary)}
.dsm-health-advise{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-rule-list{display:flex;flex-direction:column;gap:6px}
.dsm-rule-row{display:flex;align-items:flex-start;gap:8px;justify-content:space-between;padding:8px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-base);border:1px solid var(--dsw-alias-border-l3)}
.dsm-rule-text{font-size:12px;line-height:1.5;flex:1;min-width:0;word-break:break-word}
.dsm-rule-main{display:flex;flex-direction:column;gap:4px;flex:1;min-width:0}
.dsm-meta-soft{font-size:11px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}
.dsm-banner{border-radius:var(--dsw-radius-md);padding:8px 12px;font-size:12px}
.dsm-banner[data-tone="error"]{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 12%,transparent);color:var(--dsw-alias-state-error-primary)}
.dsm-banner[data-tone="ok"]{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 12%,transparent);color:var(--dsw-alias-state-success-primary)}
.dsm-save{display:flex;gap:8px;align-items:center}
.dsm-save small{color:var(--dsw-alias-label-tertiary);font-size:11px}

/* ---- 输入框下方的提示条 ---- */
.dsm-inline{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:6px 12px;margin:0 0 6px;border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);font-size:12px;color:var(--dsw-alias-label-secondary)}
.dsm-inline b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsm-inline .dsm-grow{flex:1}

/* ---- 浮层 / 侧栏：整层不吃点击，卡片自己开 pointer-events ---- */
.dsm-layer{position:fixed;inset:0;pointer-events:none;z-index:60;font-size:13px;color:var(--dsw-alias-label-primary)}
/* 浮层不做全屏遮罩：外层保持 click-through，只有面板本身吃点击，
   这样待批提醒浮在页面上时不挡住用户继续操作。 */
.dsm-layer[data-mode="overlay"]{display:flex;align-items:center;justify-content:center}
.dsm-layer[data-mode="sidebar"]{display:flex;align-items:flex-start;justify-content:flex-end;padding:72px 18px 18px}
.dsm-panel{pointer-events:auto;width:380px;max-width:calc(100vw - 36px);max-height:calc(100vh - 120px);overflow:auto;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);box-shadow:var(--dsw-elevation-prominent,rgba(0,0,0,.18) 0 12px 32px);padding:16px}
.dsm-panel h4{margin:0;font-size:13px;font-weight:600}
.dsm-panel .dsm-panel-sub{color:var(--dsw-alias-label-tertiary);font-size:11px;margin:2px 0 12px}
.dsm-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:10px;position:sticky;top:0;z-index:1;background:var(--dsw-alias-bg-layer-1);padding-bottom:8px}
.dsm-close{border:0;background:transparent;color:var(--dsw-alias-label-tertiary);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;border-radius:var(--dsw-radius-sm)}
.dsm-close:hover{background:var(--dsw-alias-interactive-bg-hover)}

/* 键盘用户看得到焦点；四条 radiogroup 都靠方向键切换，Tab 只停一次。 */
.dsm-btn:focus-visible,.dsm-tab:focus-visible,.dsm-mode:focus-visible,.dsm-preset:focus-visible,.dsm-seg-btn:focus-visible,.dsm-close:focus-visible,.dsm-health-cell:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-accent-1)}
.dsm-input:focus,.dsm-textarea:focus{outline:none;border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 2px var(--dsw-alias-accent-1)}
.dsm-btn:active:not(:disabled){transform:translateY(1px)}
.dsm-rule-row>.dsm-row{flex:0 0 auto}
@media (max-width:520px){
  .dsm-page{padding:18px 16px 32px}
  .dsm-tiers,.dsm-health-grid{grid-template-columns:repeat(2,1fr)}
  .dsm-mode{padding:10px 12px}
}
@media (max-width:420px){
  .dsm-inline>span:not(.dsm-grow){display:none}
  .dsm-modeline{flex-direction:column;align-items:flex-start;gap:6px}
}
`

    function ensureStyle() {
      let el = document.getElementById(STYLE_ID)
      if (!el) {
        el = document.createElement('style')
        el.id = STYLE_ID
        document.head.appendChild(el)
      }
      // 热重载会让本模块重新执行；样式内容必须跟着换，否则旧 CSS 一直生效。
      if (el.textContent !== CSS) el.textContent = CSS
      return () => {
        const node = document.getElementById(STYLE_ID)
        if (node) node.remove()
      }
    }

    // ---------------------------------------------------------------- 数据层
    const HEADER = 'x-dsh-soul-memory'
    // 写操作的进程内令牌：同机其他脚本读不到它也拿不到，伪造不了回收/删规则这类动作。
    const TOKEN_HEADER = 'x-dsh-soul-memory-token'

    function baseDir() {
      try {
        const url = new URL(document.baseURI)
        url.search = ''
        url.hash = ''
        if (!url.pathname.endsWith('/')) {
          url.pathname = url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1) || '/'
        }
        return url.href
      } catch {
        return '/'
      }
    }

    function routeUrl(path) {
      return new URL(String(path).replace(/^\/+/, ''), baseDir()).href
    }

    async function call(path, body) {
      const headers = { [HEADER]: '1' }
      if (body) {
        headers['content-type'] = 'application/json'
        const state = store.get().state
        if (state && state.token) headers[TOKEN_HEADER] = state.token
      }
      const res = await fetch(routeUrl(path), {
        method: body ? 'POST' : 'GET',
        headers,
        body: body ? JSON.stringify(body) : undefined,
        cache: 'no-store',
        credentials: 'same-origin',
      })
      if (res.status === 204) return {}
      const text = await res.text()
      let data = {}
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error('服务端返回的不是 JSON')
        }
      }
      if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
      return data
    }

    // 一个极小的外部 store：设置页、提示条、浮层三个位置共享同一份状态，
    // 避免各拉各的导致「设置页批准了、提示条还显示 N 条」。
    function createStore() {
      const subs = new Set()
      let snapshot = { state: null, error: null, loading: false, open: false, version: 0 }
      let inflight = null
      let timer = null

      const publish = (patch) => {
        snapshot = { ...snapshot, ...patch, version: snapshot.version + 1 }
        for (const fn of subs) fn()
      }

      // 三个挂载点共用一个定时器：引用计数归零才停，避免每个组件各起一个 25s 轮询。
      const startTimer = () => {
        if (timer) return
        timer = setInterval(() => { if (!document.hidden) refresh() }, 25000)
        if (timer && typeof timer.unref === 'function') timer.unref()
      }
      const stopTimer = () => {
        if (!timer) return
        clearInterval(timer)
        timer = null
      }

      /**
       * 拉一次全量状态。force=true 时会等飞行中的请求落地再发新的，
       * 否则写操作后可能复用旧响应，界面回弹成写前状态。
       */
      const refresh = (opts = {}) => {
        if (inflight && !opts.force) return inflight
        const prev = opts.force && inflight ? inflight.catch(() => {}) : Promise.resolve()
        publish({ loading: true })
        const run = prev
          .then(() => call('dsh-soul-memory/state'))
          .then((state) => publish({ state, error: null, loading: false }))
          .catch((error) => publish({ error: String(error && error.message ? error.message : error), loading: false }))
          .finally(() => { if (inflight === run) inflight = null })
        inflight = run
        return run
      }

      return {
        get: () => snapshot,
        subscribe(fn) {
          subs.add(fn)
          if (subs.size === 1) startTimer()
          return () => {
            subs.delete(fn)
            if (subs.size === 0) stopTimer()
          }
        },
        refresh,
        openPanel: () => publish({ open: true }),
        closePanel: () => publish({ open: false }),
        setState: (state) => publish({ state }),
        // 写操作后只合并被改的字段：整份覆盖会把请求期间轮询/另一挂载点刷新的新数据回退成旧快照。
        patchState: (patch) => publish({ state: { ...(snapshot.state || {}), ...patch } }),
        setError: (error) => publish({ error }),
      }
    }

    const store = createStore()

    // 不用 useSyncExternalStore：宿主提供的 React 若没有这个 API，
    // 整个设置页会渲染失败、外壳只显示一句通用错误，很难定位。
    // useState + 订阅已经足够（subscribe 回调里总是取最新快照）。
    function useSoul() {
      const [snap, setSnap] = useState(() => store.get())
      useEffect(() => {
        const off = store.subscribe(() => setSnap(store.get()))
        if (!store.get().state && !store.get().loading) store.refresh()
        return off
      }, [])
      return snap
    }

    // 渲染出错时把真实原因显示出来，而不是让外壳兜底成「系统错误」。
    class ErrorGuard extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error) {
        console.error('[dsh-soul-memory] render failed', error)
      }

      render() {
        if (this.state.error) {
          const detail = String((this.state.error && this.state.error.message) || this.state.error)
          return h('div', { className: 'dsm-banner', 'data-tone': 'error' },
            '灵魂记忆渲染失败：' + detail + '（详细信息见浏览器控制台）')
        }
        return this.props.children
      }
    }

    // ---------------------------------------------------------------- 小组件
    function Button({ tone, disabled, onClick, children, title }) {
      return h('button', {
        type: 'button',
        className: 'dsm-btn',
        'data-tone': tone || undefined,
        disabled: disabled || undefined,
        title: title || undefined,
        onClick,
      }, children)
    }

    function Banner({ tone, children }) {
      if (!children) return null
      return h('div', { className: 'dsm-banner', 'data-tone': tone || 'error' }, children)
    }

    function Empty({ children }) {
      return h('div', { className: 'dsm-empty' }, children)
    }

    function sizeText(chars) {
      const n = Number(chars) || 0
      if (n < 10000) return n + ' 字'
      return Math.round(n / 1000) / 10 + ' 万字'
    }

    // ---------------------------------------------------------------- 体检卡
    // 五个数字一眼看完，再给一句「现在该做什么」；点数字跳对应 tab。
    function HealthCard({ data, onJump }) {
      const health = data && data.health
      if (!health) return null
      const pending = Number(health.pending) || 0
      const collectable = Number(health.collectable) || 0
      const rulesPct = Number(health.rulesPct) || 0
      const advise = pending
        ? '有 ' + pending + ' 条规则等你批准'
        : health.rulesWarn
          ? '规则快到上限了，去「规则」里删几条'
          : collectable
            ? '有 ' + collectable + ' 条低价值记忆可以回收'
            : '没有需要处理的事'
      const cells = [
        { key: 'core', label: '核心记忆', value: sizeText(health.coreBytes), hint: '每个会话都带' },
        { key: 'notes', label: '归档记忆', value: health.notes, hint: '按需检索' },
        { key: 'pending', label: '待批规则', value: pending, hint: '等你确认', jump: 'pending' },
        { key: 'rules', label: '规则用量', value: rulesPct + '%', hint: health.rulesWarn ? '快满了' : '还有余量', jump: 'rules', warn: health.rulesWarn },
        { key: 'collect', label: '可回收', value: collectable, hint: '低层长期沉默', jump: 'tiers' },
      ]
      return h('div', { className: 'dsm-health' },
        h('div', { className: 'dsm-health-grid' },
          cells.map((cell) => h('button', {
            key: cell.key,
            type: 'button',
            className: 'dsm-health-cell',
            'data-warn': cell.warn ? '1' : '0',
            disabled: !cell.jump,
            onClick: cell.jump ? () => onJump(cell.jump) : undefined,
          },
          h('b', null, cell.value),
          h('span', null, cell.label),
          h('em', null, cell.hint))),
        ),
        h('p', { className: 'dsm-health-advise' }, advise),
      )
    }

    // ---------------------------------------------------------------- 待批区
    // 三项用同一根轴（打扰程度）比较，别各写一条互不相干的形容。
    // overlay 没有全屏遮罩（见 .dsm-layer 的 click-through），描述里不能写「带遮罩」。
    const MODE_META = [
      { id: 'inline', name: '对话内提示条', desc: '输入框下方一行提示，点一下展开', cost: '最不打扰' },
      { id: 'sidebar', name: '右侧面板', desc: '常驻右边缘，随时能收起', cost: '一直可见' },
      { id: 'overlay', name: '居中浮层', desc: '有待批就浮在页面中间，不挡操作', cost: '最显眼' },
      { id: 'off', name: '不提醒', desc: '只在待批区里攒着，什么都不弹', cost: '最安静' },
    ]

    // 「不提醒」是长期选择，「静默」是带时限的临时关掉；两者对提醒的影响一样。
    function isMuted(ui) {
      if (!ui) return false
      if (ui.displayMode === 'off') return true
      return Number(ui.mutedUntil) > Date.now()
    }

    function muteLeft(ui) {
      const until = Number(ui && ui.mutedUntil) || 0
      const ms = until - Date.now()
      if (ms <= 0) return ''
      const mins = Math.ceil(ms / 60000)
      if (mins < 60) return mins + ' 分钟'
      const hours = Math.round(mins / 6) / 10
      if (hours < 24) return hours + ' 小时'
      return Math.ceil(hours / 24) + ' 天'
    }

    // 「今天」= 到当天 23:59:59，不是 24 小时后。
    function endOfDay() {
      const now = new Date()
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999).getTime()
    }

    function PendingTab({ data, busy, onBusy, patchState }) {
      const [selected, setSelected] = useState([])
      const [modeSaving, setModeSaving] = useState(false)
      const [notice, setNotice] = useState(null)
      // 行内编辑：id + 草稿。没在编辑时是 null。
      const [editing, setEditing] = useState(null)
      const [editBusy, setEditBusy] = useState(false)
      const pending = data.pending || []
      const ui = data.ui || {}
      const pendingKey = pending.map((item) => item.id).join('|')
      const muted = isMuted(ui)
      const mutedLeft = muteLeft(ui)

      useEffect(() => {
        // 列表刷新后丢掉已经不存在的选中项；按 id 串判断，避免「批准 1 条又新增 1 条」时漏清理。
        setSelected((ids) => ids.filter((id) => pending.some((item) => item.id === id)))
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pendingKey])

      const toggle = (id) => setSelected((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : ids.concat(id)))

      const changeMode = async (mode) => {
        if (mode === ui.displayMode || modeSaving) return
        setModeSaving(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/ui', { displayMode: mode })
          // 只交回被改的字段：整份 data 覆盖会把请求期间轮询到的待批列表回退成旧快照。
          patchState({ ui: res.ui || { ...ui, displayMode: mode } })
          setNotice({ tone: 'ok', text: '显示形态已切换为「' + (MODE_META.find((m) => m.id === mode)?.name || mode) + '」。' })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setModeSaving(false)
        }
      }

      const setMute = async (until) => {
        if (modeSaving) return
        setModeSaving(true)
        setNotice(null)
        try {
          // 不提醒（长期档）和静默（临时档）是两根轴，一起用会停在「已静默但还是不提醒」。
          // 点静默说明此刻想恢复提醒，所以顺手把形态切回对话内条。
          const patch = until && ui.displayMode === 'off'
            ? { mutedUntil: until, displayMode: 'inline' }
            : { mutedUntil: until }
          const res = await call('dsh-soul-memory/ui', patch)
          patchState({ ui: res.ui || { ...ui, ...patch } })
          setNotice({
            tone: 'ok',
            text: until ? '已静默到 ' + new Date(until).toLocaleString() + '，期间照常累积。' : '已恢复提醒。',
          })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setModeSaving(false)
        }
      }

      const saveEdit = async () => {
        if (!editing || editBusy) return
        const text = String(editing.text || '').trim()
        if (!text) {
          setNotice({ tone: 'error', text: '规则不能为空。' })
          return
        }
        setEditBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/pending', { action: 'edit', id: editing.id, text })
          const similar = res && res.result ? res.result.similar : null
          setEditing(null)
          setNotice({
            tone: 'ok',
            text: '已改好，还是待批状态；批准后才生效。'
              + (Array.isArray(similar) && similar.length ? '（这条和已有规则有点像，批准前留意）' : ''),
          })
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setEditBusy(false)
        }
      }

      const act = async (action, ids) => {
        if (!ids.length || busy) return
        onBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/pending', { action, ids })
          const result = (res && res.result) || {}
          const done = action === 'approve'
            ? (Array.isArray(result.applied) ? result.applied.length : 0)
            : (typeof result.removed === 'number' ? result.removed : ids.length)
          const failed = Array.isArray(result.failed) ? result.failed : []
          // 只清掉真正处理掉的：按请求 ids 清会让部分失败的那些悄悄取消勾选，重试还得重新找。
          const appliedIds = (Array.isArray(result.applied) ? result.applied : [])
            .map((item) => (typeof item === 'string' ? item : item && item.id))
            .filter(Boolean)
          const settled = action === 'approve' ? appliedIds : []
          setSelected((cur) => cur.filter((id) => !(settled.length ? settled.includes(id) : ids.includes(id))))
          if (failed.length || result.cleanupError) {
            setNotice({
              tone: 'error',
              text: (action === 'approve' ? '只批准了 ' + done + ' 条' : '只丢弃了 ' + done + ' 条')
                + (failed.length ? '，' + failed.length + ' 条失败：' + failed[0].error : '')
                + (result.cleanupError ? '，待批列表没清掉：' + result.cleanupError : ''),
            })
          } else {
            setNotice({
              tone: 'ok',
              text: action === 'approve'
                ? '已批准 ' + done + ' 条，下一轮对话就按新规则执行。'
                : '已丢弃 ' + done + ' 条待批规则。',
            })
          }
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          onBusy(false)
        }
      }

      return h(React.Fragment, null,
        h('div', { className: 'dsm-card' },
          h('h3', null, '待批区显示形态'),
          h('p', { className: 'dsm-hint' }, '有待批规则时，用哪种方式提醒你。'),
          h('div', { className: 'dsm-modes', role: 'radiogroup', 'aria-label': '待批区显示形态' },
            MODE_META.map((mode) => h('button', {
              key: mode.id,
              type: 'button',
              role: 'radio',
              'aria-checked': ui.displayMode === mode.id ? 'true' : 'false',
              className: 'dsm-mode',
              'data-active': ui.displayMode === mode.id ? '1' : '0',
              disabled: modeSaving,
              onClick: () => changeMode(mode.id),
            },
            h('span', { className: 'dsm-mode-dot' }),
            h('span', null,
              h('b', null, mode.name),
              h('span', null, mode.desc),
              h('span', { className: 'dsm-mode-cost' }, mode.cost)))),
          ),
          h('div', { className: 'dsm-mute' },
            h('span', { className: 'dsm-mute-label' },
              muted && ui.displayMode !== 'off'
                ? '已静默，还有 ' + mutedLeft
                : ui.displayMode === 'off'
                  ? '当前不提醒，只在这里累积'
                  : '临时静默'),
            h(Button, { tone: 'ghost', disabled: modeSaving, onClick: () => setMute(Date.now() + 3600 * 1000) }, '1 小时'),
            h(Button, { tone: 'ghost', disabled: modeSaving, onClick: () => setMute(endOfDay()) }, '今天'),
            Number(ui.mutedUntil) > 0
              ? h(Button, { tone: 'ghost', disabled: modeSaving, onClick: () => setMute(0) }, '恢复')
              : null,
          ),
          notice ? h('div', { style: { marginTop: 12 } }, h(Banner, { tone: notice.tone }, notice.text)) : null,
        ),

        h('div', { className: 'dsm-card' },
          h('div', { className: 'dsm-head' },
            h('div', null,
              h('h3', null, '待批规则', h('span', { className: 'dsm-count' }, pending.length)),
              pending.length
                ? h('p', { className: 'dsm-hint' }, '模型自己归纳、还没经你确认的规则。只出现一次的结论不该进全局，所以先停在这里。')
                : null,
            ),
            pending.length
              ? h('div', { className: 'dsm-row' },
                h(Button, {
                  onClick: () => setSelected(selected.length === pending.length ? [] : pending.map((item) => item.id)),
                  tone: 'ghost',
                }, selected.length === pending.length ? '清空选择' : '全选'),
                h(Button, {
                  tone: 'primary',
                  disabled: !selected.length || busy,
                  onClick: () => act('approve', selected),
                }, '批准所选'),
                h(Button, {
                  tone: 'danger',
                  disabled: !selected.length || busy,
                  onClick: () => act('reject', selected),
                }, '丢弃所选'),
              )
              : null,
          ),
          data.pendingError ? h(Banner, { tone: 'error' }, '读取待批列表失败：' + data.pendingError) : null,
          pending.length === 0
            ? h(Empty, null, '模型归纳的规则会先停在这里，你批准后才生效。')
            : h('div', { className: 'dsm-list' },
              pending.map((item) => {
                const checked = selected.includes(item.id)
                return h('div', { key: item.id, className: 'dsm-item' },
                  h('div', { className: 'dsm-item-top' },
                    h('input', {
                      type: 'checkbox',
                      checked,
                      onChange: () => toggle(item.id),
                      'aria-label': '选择这条规则',
                      style: { marginTop: 3 },
                    }),
                    h('div', { className: 'dsm-item-text' },
                      editing && editing.id === item.id
                        ? h('textarea', {
                            className: 'dsm-textarea',
                            value: editing.text,
                            rows: 3,
                            'aria-label': '修改这条规则',
                            onChange: (e) => setEditing({ id: item.id, text: e.target.value }),
                          })
                        : item.text),
                  ),
                  (item.why || item.pitfall || item.source) ? h('div', { className: 'dsm-meta' },
                    item.why ? h('span', null, '为什么：', h('em', null, item.why)) : null,
                    item.pitfall ? h('span', null, '陷阱：', h('em', null, item.pitfall)) : null,
                    item.source ? h('span', null, '来源：', h('em', null, item.source === 'model' ? '模型归纳' : item.source)) : null,
                    item.createdAt ? h('span', null, new Date(item.createdAt).toLocaleString()) : null,
                  ) : null,
                  h('div', { className: 'dsm-row', style: { marginTop: 10 } },
                    editing && editing.id === item.id
                      ? [
                          h(Button, { key: 'save', tone: 'primary', disabled: editBusy, onClick: saveEdit }, '保存修改'),
                          h(Button, { key: 'cancel', tone: 'ghost', disabled: editBusy, onClick: () => setEditing(null) }, '取消'),
                        ]
                      : [
                          h(Button, { key: 'edit', tone: 'ghost', disabled: busy, onClick: () => setEditing({ id: item.id, text: item.text }) }, '改一下'),
                          h(Button, { key: 'ok', tone: 'primary', disabled: busy, onClick: () => act('approve', [item.id]) }, '批准'),
                          h(Button, { key: 'no', tone: 'danger', disabled: busy, onClick: () => act('reject', [item.id]) }, '丢弃'),
                        ],
                  ),
                )
              }),
            ),
        ),
      )
    }

    // ---------------------------------------------------------------- 规则
    function RulesTab({ data }) {
      const text = String(data.rules || '').trim()
      const list = Array.isArray(data.rulesList) ? data.rulesList : []
      const usage = data.rulesUsage || null
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      // 删除是不可撤销的（要恢复只能重新写一条），所以每次都要再点一下确认。
      const [confirming, setConfirming] = useState(null)
      const [showRaw, setShowRaw] = useState(false)
      // 编辑弹窗：original 是定位用的原正文，保存时整条替换（规则 + 为什么 + 陷阱）。
      const [editing, setEditing] = useState(null)
      const [editBusy, setEditBusy] = useState(false)
      const editingOpen = editing !== null
      // 注入上限：留空 = 跟随宿主配置（0）；填数字就覆盖宿主配置。
      const limits = data.limits || {}
      const minBudget = Number(limits.minRulesBudget) || 400
      const maxBudget = Number(limits.maxRulesBudget) || 8000
      const [budgetDraft, setBudgetDraft] = useState(
        data.ui && Number(data.ui.rulesBudget) > 0 ? String(data.ui.rulesBudget) : '',
      )
      const [budgetBusy, setBudgetBusy] = useState(false)
      // 新建规则：表单内联展开，不弹窗（弹窗留给编辑，避免两个弹窗抢焦点）。
      const [adding, setAdding] = useState(null)
      const [addBusy, setAddBusy] = useState(false)
      const [dupes, setDupes] = useState(null)
      const [dupesBusy, setDupesBusy] = useState(false)

      useEffect(() => {
        if (!editingOpen) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setEditing(null) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [editingOpen])

      const remove = async (ruleText) => {
        if (busy) return
        setBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/rules', { action: 'forget', text: ruleText })
          const use = res && res.usage
          setConfirming(null)
          setNotice({
            tone: 'ok',
            text: '已删除一条规则' + (use ? '，现在注入 ' + use.used + '/' + use.budget + ' 字' : '') + '，下一轮生效。',
          })
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      const saveEdit = async () => {
        if (!editing || editBusy) return
        const next = String(editing.text || '').trim()
        if (!next) { setNotice({ tone: 'error', text: '规则内容不能为空。' }); return }
        setEditBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/rules', {
            action: 'edit',
            text: editing.original,
            nextText: next,
            why: editing.why || '',
            pitfall: editing.pitfall || '',
          })
          setEditing(null)
          const use = res && res.usage
          setNotice({
            tone: 'ok',
            text: '已保存' + (use ? '，现在注入 ' + use.used + '/' + use.budget + ' 字' : '') + '，下一轮生效。'
              + (res && Array.isArray(res.similar) && res.similar.length ? ' ⚠️ 与另一条规则可能重复，注意别写成两条。' : ''),
          })
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setEditBusy(false)
        }
      }

      // 保存注入上限：留空写 0（跟随宿主配置），否则写 400–8000 的整数。
      const saveBudget = async () => {
        if (budgetBusy) return
        const raw = String(budgetDraft == null ? '' : budgetDraft).trim()
        const value = raw === '' ? 0 : Number(raw)
        const valid = Number.isFinite(value) && (value === 0 || (value >= minBudget && value <= maxBudget))
        if (!valid) {
          setNotice({ tone: 'error', text: `上限只能是 ${minBudget}–${maxBudget} 之间的整数，留空表示跟随宿主配置` })
          return
        }
        setBudgetBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/ui', { rulesBudget: Math.round(value) })
          store.refresh({ force: true })
          setNotice({
            tone: 'ok',
            text: res && Number(res.rulesBudget) > 0
              ? '上限已改为 ' + res.rulesBudget + ' 字，下一轮生效。'
              : '已恢复跟随宿主配置，下一轮生效。',
          })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error && error.message ? error.message : error) })
        } finally {
          setBudgetBusy(false)
        }
      }

      const submitAdd = async () => {
        if (!adding || addBusy) return
        const text = String(adding.text || '').trim()
        if (!text) { setNotice({ tone: 'error', text: '规则内容不能为空。' }); return }
        setAddBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/rules', { action: 'add', text, why: adding.why || '', pitfall: adding.pitfall || '' })
          setAdding(null)
          const use = res && res.usage
          setNotice({
            tone: 'ok',
            text: '已新增一条规则' + (use ? '，现在注入 ' + use.used + '/' + use.budget + ' 字' : '') + '，下一轮生效。'
              + (res && Array.isArray(res.similar) && res.similar.length ? ' ⚠️ 与已有规则可能重复，考虑合并。' : ''),
          })
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setAddBusy(false)
        }
      }

      const scanDupes = async () => {
        if (dupesBusy) return
        setDupesBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/rules', { action: 'dupes' })
          setDupes(Array.isArray(res && res.pairs) ? res.pairs : [])
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setDupesBusy(false)
        }
      }

      const meter = usage
        ? h('div', { className: 'dsm-meter', role: 'img', 'aria-label': '规则用量 ' + usage.pct + '%' },
            h('div', { className: 'dsm-meter-fill', 'data-warn': usage.warn ? '1' : '0', style: { width: Math.max(2, Math.min(100, usage.pct)) + '%' } }),
          )
        : null

      return h('div', { className: 'dsm-card' },
        h('div', { className: 'dsm-head', style: { marginBottom: 12 } },
          h('div', null,
            h('h3', null, '全局编码规范', h('span', { className: 'dsm-count' }, list.length)),
            h('p', { className: 'dsm-hint' }, '这里是真正会注入每个会话的规则。要加规则让模型用 coding_rules；这里可以逐条删。'),
            usage
              ? h('p', { className: 'dsm-hint' }, '注入用量 ' + usage.used + '/' + usage.budget + ' 字（' + usage.pct + '%）' + (usage.warn ? ' · 快满了，先合并或删几条旧规则' : ''))
              : null,
            h('div', { className: 'dsm-budget' },
              h('span', { className: 'dsm-hint' }, '注入上限'),
              h('input', {
                className: 'dsm-input dsm-budget-input',
                type: 'number',
                min: minBudget,
                max: maxBudget,
                step: 100,
                value: budgetDraft,
                placeholder: usage ? String(usage.budget) : '',
                'aria-label': '编码规范注入上限字数',
                onChange: (event) => setBudgetDraft(event.target.value),
              }),
              h('span', { className: 'dsm-hint' }, '字'),
              h(Button, { tone: 'ghost', disabled: budgetBusy, onClick: saveBudget }, budgetBusy ? '保存中…' : '保存'),
              h('span', { className: 'dsm-hint' }, '留空 = 跟随宿主配置'),
            ),
          ),
          h(Button, {
            tone: 'primary',
            disabled: addBusy || busy,
            onClick: () => setAdding({ text: '', why: '', pitfall: '' }),
          }, '新建规则'),
          h(Button, {
            tone: 'ghost',
            disabled: dupesBusy || list.length < 2,
            onClick: scanDupes,
          }, dupesBusy ? '扫描中…' : '查重'),
          h(Button, {
            tone: 'ghost',
            disabled: !text,
            onClick: () => {
              if (!text) return
              const done = () => {
                setNotice({ tone: 'ok', text: '已复制 ' + text.length + ' 字' })
                setTimeout(() => setNotice(null), 2000)
              }
              const pending = navigator.clipboard && navigator.clipboard.writeText(text)
              if (pending && pending.then) pending.then(done, () => setNotice({ tone: 'error', text: '复制失败，可以展开原文手动选中' }))
              else done()
            },
          }, '复制全文'),
        ),
        meter,
        notice ? h('div', { style: { marginBottom: 10 } }, h(Banner, { tone: notice.tone }, notice.text)) : null,
        adding
          ? h('div', { style: { marginBottom: 14 } },
            h('label', { className: 'dsm-field' },
              h('span', { className: 'dsm-field-label' }, '新规则（一句话，说清什么场景必须遵守）'),
              h('textarea', {
                className: 'dsm-textarea',
                rows: 3,
                value: adding.text,
                onChange: (event) => setAdding({ ...adding, text: event.target.value }),
              }),
            ),
            h('label', { className: 'dsm-field' },
              h('span', { className: 'dsm-field-label' }, '为什么（可选，写给模型看的理由）'),
              h('textarea', {
                className: 'dsm-textarea',
                rows: 2,
                value: adding.why,
                onChange: (event) => setAdding({ ...adding, why: event.target.value }),
              }),
            ),
            h('label', { className: 'dsm-field' },
              h('span', { className: 'dsm-field-label' }, '陷阱（可选，什么时候会踩坑）'),
              h('textarea', {
                className: 'dsm-textarea',
                rows: 2,
                value: adding.pitfall,
                onChange: (event) => setAdding({ ...adding, pitfall: event.target.value }),
              }),
            ),
            h('div', { className: 'dsm-row' },
              h(Button, { tone: 'primary', disabled: addBusy || !String(adding.text || '').trim(), onClick: submitAdd }, addBusy ? '保存中…' : '保存'),
              h(Button, { tone: 'ghost', disabled: addBusy, onClick: () => setAdding(null) }, '取消'),
            ),
          )
          : null,
        dupes
          ? h('div', { style: { marginBottom: 12 } },
            h(Banner, { tone: 'ok' }, dupes.length
              ? '发现 ' + dupes.length + ' 对措辞相近的规则，考虑合并成一条：'
              : '没有发现措辞相近的规则。'),
            dupes.length
              ? h('div', { className: 'dsm-rule-list', style: { marginTop: 8 } },
                dupes.map((pair, index) => h('div', { key: 'dupe' + index, className: 'dsm-rule-row' },
                  h('span', { className: 'dsm-rule-text' }, pair.a + '  ／  ' + pair.b),
                  h('span', { className: 'dsm-meta-soft' }, String(pair.score)),
                )),
              )
              : null,
          )
          : null,
        list.length
          ? h('div', { className: 'dsm-rule-list' },
            list.map((rule, index) => h('div', { key: 'r' + index, className: 'dsm-rule-row' },
              h('div', { className: 'dsm-rule-main' },
                h('span', { className: 'dsm-rule-text' }, rule.text),
                (rule.why || rule.pitfall) ? h('div', { className: 'dsm-meta' },
                  rule.why ? h('span', null, '为什么：', h('em', null, rule.why)) : null,
                  rule.pitfall ? h('span', null, '陷阱：', h('em', null, rule.pitfall)) : null,
                ) : null,
              ),
              confirming === rule.text
                ? h('span', { className: 'dsm-row' },
                  h(Button, { tone: 'danger', disabled: busy, onClick: () => remove(rule.text) }, '确认删除'),
                  h(Button, { tone: 'ghost', disabled: busy, onClick: () => setConfirming(null) }, '算了'),
                )
                : h('span', { className: 'dsm-row' },
                  h(Button, {
                    tone: 'ghost',
                    disabled: busy,
                    onClick: () => setEditing({ original: rule.text, text: rule.text, why: rule.why || '', pitfall: rule.pitfall || '' }),
                  }, '编辑'),
                  h(Button, { tone: 'danger', disabled: busy, onClick: () => setConfirming(rule.text) }, '删除'),
                ),
            )),
          )
          : h(Empty, null, '还没有全局规则。'),
        text
          ? h('div', { style: { marginTop: 12 } },
            h(Button, { tone: 'ghost', onClick: () => setShowRaw((v) => !v) }, showRaw ? '收起原文' : '查看原文'),
            showRaw ? h('pre', { className: 'dsm-rules' }, text) : null,
          )
          : null,
        editing ? h('div', {
          className: 'dsm-modal-mask',
          onClick: (event) => { if (event.target === event.currentTarget) setEditing(null) },
        },
          h('div', { className: 'dsm-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '编辑规则' },
            h('div', { className: 'dsm-modal-head' },
              h('h3', { className: 'dsm-modal-title' }, '编辑规则'),
              h(Button, { tone: 'ghost', disabled: editBusy, onClick: () => setEditing(null) }, '关闭'),
            ),
            h('label', { className: 'dsm-field' },
              h('span', { className: 'dsm-field-label' }, '规则'),
              h('textarea', {
                className: 'dsm-textarea',
                rows: 3,
                value: editing.text,
                onChange: (event) => setEditing({ ...editing, text: event.target.value }),
              }),
            ),
            h('label', { className: 'dsm-field' },
              h('span', { className: 'dsm-field-label' }, '为什么（可选，写给模型看的理由）'),
              h('textarea', {
                className: 'dsm-textarea',
                rows: 2,
                value: editing.why,
                onChange: (event) => setEditing({ ...editing, why: event.target.value }),
              }),
            ),
            h('label', { className: 'dsm-field' },
              h('span', { className: 'dsm-field-label' }, '陷阱（可选，什么时候会踩坑）'),
              h('textarea', {
                className: 'dsm-textarea',
                rows: 2,
                value: editing.pitfall,
                onChange: (event) => setEditing({ ...editing, pitfall: event.target.value }),
              }),
            ),
            h('div', { className: 'dsm-modal-actions' },
              h(Button, { tone: 'ghost', disabled: editBusy, onClick: () => setEditing(null) }, '取消'),
              h(Button, {
                tone: 'primary',
                disabled: editBusy || !String(editing.text || '').trim(),
                onClick: saveEdit,
              }, editBusy ? '保存中…' : '保存'),
            ),
          ),
        ) : null,
      )
    }

    // ---------------------------------------------------------------- 称呼与风格
    function IdentityTab({ data, patchState }) {
      const ui = data.ui || {}
      const persona = data.persona || {}
      const presets = data.presets || []
      const limits = data.limits || {}
      const paused = !!ui.memoryPaused
      const [nickname, setNickname] = useState(ui.nickname || '')
      const [preset, setPreset] = useState(persona.preset || 'default')
      const [custom, setCustom] = useState(persona.custom || '')
      const [enabled, setEnabled] = useState(persona.enabled !== false)
      const [busy, setBusy] = useState(false)
      // 称呼与风格各用一条提示，避免「保存称呼」的反馈渲染到风格卡片里。
      const [nickNotice, setNickNotice] = useState(null)
      const [notice, setNotice] = useState(null)
      // 暂停写记忆单独一条，免得它的反馈出现在上面两张卡片的提示位。
      const [pauseNotice, setPauseNotice] = useState(null)
      // 暂停会静默关掉自动记忆，点一次就生效太容易误触：先进入确认态，再点一次才写。
      const [confirmingPause, setConfirmingPause] = useState(false)

      // 两个表单各记各的「有没有改动」：共用一个 ref 时，改称呼会挡住风格的同步，反之亦然。
      const nickDirty = useRef(false)
      const personaDirty = useRef(false)
      // 保存飞行期间用户可能继续输入；只在「输入框仍是提交值」时才解除保护。
      const nickRef = useRef(nickname)
      nickRef.current = nickname
      useEffect(() => { if (!nickDirty.current) setNickname(ui.nickname || '') }, [ui.nickname])
      useEffect(() => {
        if (personaDirty.current) return
        setPreset(persona.preset || 'default')
        setCustom(persona.custom || '')
        setEnabled(persona.enabled !== false)
      }, [persona.preset, persona.custom, persona.enabled])

      const saveNickname = async () => {
        const submitted = nickname
        setBusy(true)
        setNickNotice(null)
        try {
          const res = await call('dsh-soul-memory/ui', { nickname: submitted })
          patchState({ ui: res.ui || { ...ui, nickname: submitted } })
          if (nickRef.current === submitted) nickDirty.current = false
          setNickNotice({ tone: 'ok', text: submitted ? '已保存称呼：' + submitted : '已清除称呼。' })
        } catch (error) {
          setNickNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      const savePersona = async () => {
        const submitted = { preset, custom, enabled }
        setBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/persona', submitted)
          patchState({ persona: res.persona || { ...persona, ...submitted }, presets: res.presets || presets })
          personaDirty.current = false
          setNotice({ tone: 'ok', text: '回复风格已保存，下一轮对话就生效。' })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      const togglePause = async (paused) => {
        if (busy) return
        setBusy(true)
        setPauseNotice(null)
        try {
          const res = await call('dsh-soul-memory/ui', { memoryPaused: paused })
          patchState({ ui: res.ui || { ...ui, memoryPaused: paused } })
          setPauseNotice({ tone: 'ok', text: paused ? '已暂停写记忆，下一轮生效。' : '已恢复写记忆。' })
        } catch (error) {
          setPauseNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      return h(React.Fragment, null,
        h('div', { className: 'dsm-card' },
          h('h3', null, '称呼'),
          h('p', { className: 'dsm-hint' }, '写进系统提示的「称呼」段，每个会话都会带上。留空则不注入。'),
          h('div', { className: 'dsm-field' },
            h('input', {
              className: 'dsm-input',
              value: nickname,
              maxLength: limits.maxNickname || 40,
              placeholder: '例如：山大王',
              onChange: (e) => { nickDirty.current = true; setNickname(e.target.value) },
            }),
            h('div', { className: 'dsm-save' },
              h(Button, { tone: 'primary', disabled: busy, onClick: saveNickname }, '保存称呼'),
              h('small', null, '上限 ' + (limits.maxNickname || 40) + ' 字'),
            ),
          ),
          nickNotice ? h('div', { style: { marginTop: 12 } }, h(Banner, { tone: nickNotice.tone }, nickNotice.text)) : null,
        ),

        h('div', { className: 'dsm-card' },
          h('h3', null, '回复风格'),
          h('p', { className: 'dsm-hint' }, '风格指令会注入每个会话。选「自定义」时以你写的正文为准。'),
          h('div', { className: 'dsm-field' },
            h('div', { className: 'dsm-presets', role: 'radiogroup', 'aria-label': '回复风格预设' },
              presets.map((item) => h('button', {
                key: item.id,
                type: 'button',
                role: 'radio',
                'aria-checked': preset === item.id ? 'true' : 'false',
                className: 'dsm-preset',
                'data-active': preset === item.id ? '1' : '0',
                onClick: () => { personaDirty.current = true; setPreset(item.id) },
              },
              h('b', null, item.name),
              h('span', null, item.summary))),
            ),
          ),
          h('div', { className: 'dsm-field' },
            h('label', { className: 'dsm-label' }, '自定义风格（可选）'),
            h('textarea', {
              className: 'dsm-textarea',
              value: custom,
              maxLength: limits.maxCustom || 4000,
              placeholder: '例如：回答短、直白、少术语；先给结论，再给不超过三条要点。',
              onChange: (e) => { personaDirty.current = true; setCustom(e.target.value) },
            }),
            h('small', { style: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 11 } },
              (custom.length || 0) + ' / ' + (limits.maxCustom || 4000) + ' 字符'),
          ),
          h('div', { className: 'dsm-row', style: { marginBottom: 12 } },
            h('label', { className: 'dsm-row', style: { gap: 6, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox',
                checked: enabled,
                onChange: (e) => { personaDirty.current = true; setEnabled(e.target.checked) },
              }),
              h('span', null, '启用风格注入'),
            ),
          ),
          h('div', { className: 'dsm-save' },
            h(Button, { tone: 'primary', disabled: busy, onClick: savePersona }, '保存风格'),
            notice ? h(Banner, { tone: notice.tone }, notice.text) : null,
          ),
        ),

        h('div', { className: 'dsm-card' },
          h('h3', null, '记忆写入'),
          h('p', { className: 'dsm-hint' }, '暂停后，模型不会再自动写归档记忆和待批规则；你明确要求记的也不写。'),
          h('div', { className: 'dsm-seg', role: 'radiogroup', 'aria-label': '记忆写入' },
            h('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': !paused,
              className: 'dsm-seg-btn',
              'data-active': !paused ? '1' : '0',
              disabled: busy,
              onClick: () => { if (paused) togglePause(false) },
            }, '正常写入'),
            h('button', {
              type: 'button',
              role: 'radio',
              'aria-checked': paused,
              className: 'dsm-seg-btn',
              'data-active': paused ? '1' : '0',
              disabled: busy,
              onClick: () => {
                if (paused) return
                if (!confirmingPause) { setConfirmingPause(true); return }
                setConfirmingPause(false)
                togglePause(true)
              },
            }, confirmingPause ? '确认暂停' : '已暂停'),
          ),
          paused ? h('div', { className: 'dsm-meta', style: { marginTop: 8 } }, '下一轮生效') : null,
          pauseNotice ? h('div', { style: { marginTop: 10 } }, h(Banner, { tone: pauseNotice.tone }, pauseNotice.text)) : null,
        ),
      )
    }

    // ---------------------------------------------------------------- 分级
    function TiersTab({ data }) {
      const tiers = data.tiers || {}
      const dreaming = data.dreaming || {}
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      // 先预演拿到候选，确认后才真回收；lastIds 留着给「撤销」。
      const [candidates, setCandidates] = useState(null)
      const [lastIds, setLastIds] = useState(null)
      // 回收门槛天数：默认跟当前统计一致，用户可改；最低 7（与 SQL 判据一致）。
      const [days, setDays] = useState(String(tiers.minAgeDays || 90))
      const [draining, setDraining] = useState(false)
      const ageDays = () => {
        const value = Number(days)
        return Number.isFinite(value) && value >= 7 ? Math.round(value) : undefined
      }

      const run = async (body, after) => {
        if (busy) return
        setBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/tier', body)
          after(res)
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      const preview = () => run({ action: 'preview', minAgeDays: ageDays() }, (res) => {
        const list = res.candidates || []
        setCandidates(list)
        setNotice({ tone: 'ok', text: list.length ? '找到 ' + list.length + ' 条可回收，看一眼再决定。' : '没有符合条件的记忆。' })
      })

      const collect = () => run({ action: 'collect', ids: (candidates || []).map((c) => c.id), minAgeDays: ageDays() }, (res) => {
        setCandidates(null)
        setLastIds(res.ids || [])
        setNotice({ tone: 'ok', text: '已回收 ' + (res.collected || 0) + ' 条（标记为 retired，可撤销）。' })
      })

      const restore = () => run({ action: 'restore', ids: lastIds || [] }, (res) => {
        setLastIds(null)
        setNotice({ tone: 'ok', text: '已恢复 ' + (res.restored || 0) + ' 条。' })
      })

      const setDreaming = async (enabled) => {
        if (busy) return
        setBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/dreaming', { enabled })
          patchDreaming(res)
          setNotice({ tone: 'ok', text: enabled ? '闲时整理已开启。' : '闲时整理已关闭。' })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      // 开关状态来自 /state；单独拉一次太重，直接用 patchState 合并。
      const patchDreaming = (res) => {
        const next = (res && res.dreaming) || { enabled: !dreaming.enabled }
        store.patchState({ dreaming: next })
      }

      const cells = [
        { key: 'high', label: '🔴 高（约束/钉住）', value: tiers.high || 0, hint: '永不自动回收' },
        { key: 'medium', label: '🟡 中（决策/进度）', value: tiers.medium || 0, hint: '按需保留' },
        { key: 'low', label: '🟢 低（产物/索引）', value: tiers.low || 0, hint: '长期沉默可回收' },
      ]

      return h(React.Fragment, null,
        h('div', { className: 'dsm-card' },
          h('h3', null, '记忆分级'),
          h('p', { className: 'dsm-hint' }, '按 kind 分级，与 memory_tier 工具同一套判据。回收只是标记 retired，可随时恢复。'),
          h('div', { className: 'dsm-tiers' },
            cells.map((cell) => h('div', { key: cell.key, className: 'dsm-tier' },
              h('b', null, cell.value),
              h('span', null, cell.label),
              h('span', { style: { display: 'block', marginTop: 4 } }, cell.hint),
            )),
          ),
          h('p', { className: 'dsm-hint', style: { marginTop: 14 } },
            '可回收 ' + (tiers.collectable || 0) + ' 条（低层 + 未被命中 + 超过 ' + (tiers.minAgeDays || 90) + ' 天）。'),
          h('div', { className: 'dsm-budget' },
            h('span', { className: 'dsm-hint' }, '回收门槛'),
            h('input', {
              className: 'dsm-input dsm-budget-input',
              type: 'number',
              min: 7,
              step: 10,
              value: days,
              'aria-label': '回收门槛天数',
              onChange: (event) => setDays(event.target.value),
            }),
            h('span', { className: 'dsm-hint' }, '天没动过才回收（最低 7）'),
          ),
          h('div', { className: 'dsm-row' },
            h(Button, { tone: 'primary', disabled: busy, onClick: preview }, '看看能回收哪些'),
            candidates && candidates.length
              ? h(Button, { tone: 'danger', disabled: busy, onClick: collect }, '确认回收 ' + candidates.length + ' 条')
              : null,
            lastIds && lastIds.length
              ? h(Button, { tone: 'ghost', disabled: busy, onClick: restore }, '撤销刚才的回收')
              : null,
          ),
          notice ? h('div', { style: { marginTop: 12 } }, h(Banner, { tone: notice.tone }, notice.text)) : null,
          candidates && candidates.length
            ? h('div', { className: 'dsm-rule-list', style: { marginTop: 10 } },
              candidates.slice(0, 30).map((item) => h('div', { key: item.id, className: 'dsm-rule-row' },
                h('span', { className: 'dsm-rule-text' }, item.claim),
                h('span', { className: 'dsm-meta-soft' }, item.ageDays + ' 天没动过'),
              )),
            )
            : null,
        ),

        h('div', { className: 'dsm-card' },
          h('div', { className: 'dsm-head' },
            h('div', null,
              h('h3', null, '闲时整理'),
              h('p', { className: 'dsm-hint' }, '开启后把近期的决策/进度聚成摘要，并挑出重复或过时的记忆标记为 retired（可恢复）。默认关闭。'),
            ),
            h(Button, {
              tone: dreaming.enabled ? 'danger' : 'primary',
              disabled: busy || dreaming.corrupt,
              onClick: () => setDreaming(!dreaming.enabled),
            }, dreaming.enabled ? '关闭' : '开启'),
          ),
          dreaming.corrupt
            ? h(Banner, { tone: 'error' }, '整理配置文件损坏，开关不可用（详情见宿主日志）。')
            : null,
          dreaming.lastRunAt
            ? h('p', { className: 'dsm-hint' }, '上次整理：' + new Date(dreaming.lastRunAt).toLocaleString())
            : h('p', { className: 'dsm-hint' }, '还没运行过。'),
          !dreaming.configured
            ? h('p', { className: 'dsm-hint' }, '当前没有配置模型路由，开启后只做本地聚合，不做 AI 判断。')
            : null,
          h('div', { className: 'dsm-row', style: { marginTop: 10 } },
            h(Button, {
              tone: 'ghost',
              disabled: busy || draining,
              onClick: async () => {
                if (draining) return
                setDraining(true)
                setNotice(null)
                try {
                  await call('dsh-soul-memory/dreaming', { action: 'run', apply: false })
                  setNotice({ tone: 'ok', text: '已预演一次整理（只列候选，不写盘）。要看候选请直接让我跑 memory_dreaming。' })
                  await store.refresh({ force: true })
                } catch (error) {
                  setNotice({ tone: 'error', text: String(error.message || error) })
                } finally {
                  setDraining(false)
                }
              },
            }, draining ? '整理中…' : '现在整理一次（只预演）'),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 记忆内容
    // 用户最高频的问题是「你到底记住了我什么」，所以单独一页把归档笔记、
    // 踩坑和回合日志摊开；只读，写入仍走模型工具，避免第二个写源。
    function MemoriesTab() {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      const load = async () => {
        setBusy(true)
        setError(null)
        try {
          setData(await call('dsh-soul-memory/memories'))
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }
      useEffect(() => { load() }, [])
      // 备份：列表走 GET，导出/导入走 POST（要写令牌）。导入默认预演。
      const [backups, setBackups] = useState(null)
      const [backupBusy, setBackupBusy] = useState(false)
      const [backupNote, setBackupNote] = useState(null)
      const loadBackups = async () => {
        try {
          const res = await call('dsh-soul-memory/backup')
          setBackups(Array.isArray(res && res.backups) ? res.backups : [])
        } catch (error) {
          setBackupNote({ tone: 'error', text: String(error.message || error) })
        }
      }
      useEffect(() => { loadBackups() }, [])
      const doExport = async () => {
        if (backupBusy) return
        setBackupBusy(true)
        setBackupNote(null)
        try {
          const res = await call('dsh-soul-memory/backup', { action: 'export' })
          const result = (res && res.result) || {}
          setBackupNote({ tone: 'ok', text: '已导出 ' + (result.files || 0) + ' 个文件（' + (result.bytes || 0) + ' 字节）：' + (result.path || '') })
          await loadBackups()
        } catch (error) {
          setBackupNote({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBackupBusy(false)
        }
      }
      const doImport = async (file, apply) => {
        if (backupBusy) return
        setBackupBusy(true)
        setBackupNote(null)
        try {
          const res = await call('dsh-soul-memory/backup', { action: 'import', file, apply })
          const result = (res && res.result) || {}
          setBackupNote({
            tone: 'ok',
            text: (apply ? '已导入：' : '预演结果：') + '新增 ' + (result.added || []).length + '、改动 ' + (result.changed || []).length + '、相同 ' + (result.same || 0) + (apply ? '（原文件已快照）' : '（还没写盘）'),
          })
        } catch (error) {
          setBackupNote({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBackupBusy(false)
        }
      }
      if (error) return h(Empty, null, '读不到记忆内容：' + error)
      if (!data) return h(Empty, null, busy ? '正在读取…' : '加载中…')
      const notes = data.notes || []
      const journal = data.journal || []
      return h('div', null,
        h('div', { className: 'dsm-card' },
          h('div', { className: 'dsm-head' },
            h('div', null,
              h('h3', null, '归档笔记 ', h('span', { className: 'dsm-count' }, notes.length)),
              h('p', { className: 'dsm-hint' }, '模型在对话里存下的长期记忆，只读；要改或删，直接对我说。'),
            ),
            h(Button, { tone: 'ghost', disabled: busy, onClick: load }, busy ? '刷新中…' : '刷新'),
          ),
          notes.length
            ? h('div', { className: 'dsm-rule-list' },
              notes.slice(0, 120).map((note) => h('div', { key: note.id, className: 'dsm-rule-row' },
                h('span', { className: 'dsm-rule-text' }, note.title),
                h('span', { className: 'dsm-meta-soft' }, note.chars + ' 字'),
              )))
            : h(Empty, null, '还没有归档笔记。'),
        ),
        h('div', { className: 'dsm-card', style: { marginTop: 14 } },
          h('div', { className: 'dsm-head' },
            h('div', null,
              h('h3', null, '备份与搬家'),
              h('p', { className: 'dsm-hint' }, '把记忆打包成一个 JSON 带走，换电脑或误删时放回来。导入前会自动给现有文件留一份快照。'),
            ),
            h(Button, { tone: 'primary', disabled: backupBusy, onClick: doExport }, backupBusy ? '处理中…' : '现在备份'),
          ),
          backupNote ? h('div', { style: { marginTop: 10 } }, h(Banner, { tone: backupNote.tone }, backupNote.text)) : null,
          backups === null
            ? h('p', { className: 'dsm-hint' }, '正在读取备份列表…')
            : backups.length
              ? h('div', { className: 'dsm-rule-list', style: { marginTop: 10 } },
                backups.slice(0, 10).map((item) => h('div', { key: item.name, className: 'dsm-rule-row' },
                  h('span', { className: 'dsm-rule-text' }, item.name),
                  h('span', { className: 'dsm-meta-soft' }, (item.bytes || 0) + ' 字节'),
                  h('span', { className: 'dsm-row' },
                    h(Button, { tone: 'ghost', disabled: backupBusy, onClick: () => doImport(item.name, false) }, '预演导入'),
                    h(Button, { tone: 'danger', disabled: backupBusy, onClick: () => doImport(item.name, true) }, '真正导入'),
                  ),
                )),
              )
              : h(Empty, null, '还没有备份，点右上角「现在备份」。'),
        ),
        h('div', { className: 'dsm-card', style: { marginTop: 14 } },
          h('h3', null, '踩坑记录'),
          h('p', { className: 'dsm-hint' }, '同类命令报错后又恢复时自动记下，目前 ' + (data.lessons || 0) + ' 类。这类记录由工具自动维护，页面上只做展示。'),
        ),
        h('div', { className: 'dsm-card', style: { marginTop: 14 } },
          h('h3', null, '最近几天的回合日志'),
          h('p', { className: 'dsm-hint' }, '每轮有实际写入时记一行，用来回想「前几天在做什么」。'),
          journal.length
            ? journal.map((day) => h('div', { key: day.name, style: { marginTop: 10 } },
              h('div', { className: 'dsm-field-label' }, day.name),
              h('pre', { className: 'dsm-rules' }, day.text),
            ))
            : h(Empty, null, '还没有回合日志。'),
        ),
      )
    }

    // ---------------------------------------------------------------- 设置页
    const TABS = [
      { id: 'pending', name: '待批区' },
      { id: 'memories', name: '记忆内容' },
      { id: 'rules', name: '编码规范' },
      { id: 'identity', name: '称呼与风格' },
      { id: 'tiers', name: '记忆分级' },
    ]

    function SoulSection() {
      const snap = useSoul()
      const [tab, setTab] = useState('pending')
      const [busy, setBusy] = useState(false)
      // 刷新用本地状态：绑 snap.loading 会让每 25s 的轮询闪一次禁用。
      const [refreshing, setRefreshing] = useState(false)
      const data = snap.state
      const pendingCount = data && data.pending ? data.pending.length : 0

      const refreshNow = async () => {
        setRefreshing(true)
        try {
          // force：撞上已在飞行的请求时排队再发一次，否则点击会被静默吞掉。
          await store.refresh({ force: true })
        } finally {
          setRefreshing(false)
        }
      }

      const body = !data
        ? h('div', { className: 'dsm-card' },
          h('h3', null, snap.error ? '读不到记忆数据' : '正在读取…'),
          snap.error
            ? h('p', { className: 'dsm-hint' }, '原因：' + snap.error + '。数据在 DSH 记忆目录下，文件被占用或权限不足都会这样。')
            : null,
          snap.error
            ? h('div', { className: 'dsm-row' },
              h(Button, { tone: 'primary', disabled: refreshing, onClick: refreshNow }, refreshing ? '重试中…' : '重试'),
            )
            : null,
        )
        : tab === 'pending'
          ? h(PendingTab, { data, busy, onBusy: setBusy, patchState: store.patchState })
          : tab === 'memories'
            ? h(MemoriesTab)
            : tab === 'rules'
              ? h(RulesTab, { data })
              : tab === 'identity'
                ? h(IdentityTab, { data, patchState: store.patchState })
                : h(TiersTab, { data })

      return h('div', { className: 'dsm-root dsm-page' },
        h('div', { className: 'dsm-head' },
          h('div', null,
            h('h1', { className: 'dsm-h1' }, '灵魂记忆'),
            h('p', { className: 'dsm-sub' }, '待批规则、全局规则、称呼与回复风格、记忆分级。'),
          ),
          h(Button, { tone: 'ghost', disabled: refreshing, onClick: refreshNow }, refreshing ? '刷新中…' : '刷新'),
        ),
        snap.error && data ? h(Banner, { tone: 'error' }, snap.error) : null,
        data ? h(HealthCard, { data, onJump: setTab }) : null,
        h('div', { className: 'dsm-tabs', role: 'tablist' },
          TABS.map((item) => h('button', {
            key: item.id,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === item.id ? 'true' : 'false',
            className: 'dsm-tab',
            'data-active': tab === item.id ? '1' : '0',
            tabIndex: tab === item.id ? 0 : -1,
            onClick: () => setTab(item.id),
            onKeyDown: (event) => {
              const at = TABS.findIndex((entry) => entry.id === tab)
              const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
              if (!step) return
              event.preventDefault()
              setTab(TABS[(at + step + TABS.length) % TABS.length].id)
            },
          },
          item.name,
          item.id === 'pending' && pendingCount ? h('span', { className: 'dsm-count' }, pendingCount) : null)),
        ),
        body,
      )
    }

    // ---------------------------------------------------------------- 图标
    function SoulIcon({ size, active }) {
      const s = size || 16
      return h('svg', {
        width: s,
        height: s,
        viewBox: '0 0 24 24',
        fill: 'none',
        'aria-hidden': 'true',
        style: { color: active ? 'var(--dsw-alias-brand-primary)' : 'currentColor' },
      },
      h('path', {
        d: 'M12 21c-4.4 0-8-3.4-8-7.6C4 9.2 7.6 6 12 6s8 3.2 8 7.4C20 17.6 16.4 21 12 21Z',
        stroke: 'currentColor',
        strokeWidth: 1.6,
      }),
      h('path', { d: 'M9 3.6h6', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      h('circle', { cx: 9.6, cy: 12.6, r: 1.15, fill: 'currentColor' }),
      h('circle', { cx: 14.4, cy: 12.6, r: 1.15, fill: 'currentColor' }),
      )
    }

    // ---------------------------------------------------------------- 提示条
    function InlineNotice() {
      const snap = useSoul()
      const data = snap.state
      if (!data || !data.ui || data.ui.displayMode !== 'inline') return null
      // 不提醒 / 静默期间不出现；条目照样在设置页里累积。
      if (isMuted(data.ui)) return null
      const pending = data.pending || []
      // 无待批时保持安静：输入框下方常驻一行“没事发生”只会变成噪音。
      if (!pending.length) return null
      return h('div', { className: 'dsm-inline' },
        h('b', null, pending.length + ' 条待批规则'),
        h('span', null, '模型归纳的规则等你确认后才会生效'),
        h('span', { className: 'dsm-grow' }),
        h(Button, { tone: 'ghost', onClick: () => store.openPanel() }, '查看'),
      )
    }

    // ---------------------------------------------------------------- 侧栏 / 浮层
    function FloatingPanel() {
      const snap = useSoul()
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState(null)
      // 侧栏可以被手动收起；收起状态只活在当前页面，不落盘。
      const [collapsed, setCollapsed] = useState(false)
      // overlay 自动弹出后必须能被关掉：dismissed 记「这一批已经关过一次」。
      const [dismissed, setDismissed] = useState(false)
      const data = snap.state
      const pending = (data && data.pending) || []
      const mode = (data && data.ui && data.ui.displayMode) || 'inline'
      const pendingKey = pending.map((item) => item.id).join('|')

      // 有待批规则时把收起的侧栏自动展开，否则用户会看不到新到的条目。
      useEffect(() => {
        if (pending.length && collapsed) setCollapsed(false)
        // 只在数量变化时关心；collapsed 不进依赖，否则手动收起会被立刻撤销。
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [pending.length])

      // 待批列表变了（新增/清空）就重新允许自动弹出，避免关过一次后再也看不到。
      useEffect(() => { setDismissed(false) }, [pendingKey])

      // overlay：手动打开，或有待批且这一批还没被关掉；sidebar：常驻，除非手动收起；inline：只在点“查看”时弹一次。
      // 刚做完一批操作时即使列表已清空也要留在屏幕上，否则「已批准 N 条」永远看不到。
      // 不提醒 / 静默期间全部不显示，连操作结果也不弹——那时用户就是不想被打断。
      const mutedNow = isMuted(data && data.ui)
      const show = !mutedNow && (notice !== null || (!data || !data.ui
        ? false
        : mode === 'overlay'
          ? (snap.open || (pending.length > 0 && !dismissed))
          : mode === 'sidebar'
            ? (!collapsed && (pending.length > 0 || snap.open || notice !== null))
            : snap.open))

      const close = () => {
        setNotice(null)
        if (mode === 'sidebar') setCollapsed(true)
        if (mode === 'overlay') setDismissed(true)
        store.closePanel()
      }

      // Esc 关闭：overlay 没有别的关闭途径时至少留这条活路。
      useEffect(() => {
        if (!show) return undefined
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          if (mode === 'sidebar') setCollapsed(true)
          else if (mode === 'overlay') setDismissed(true)
          store.closePanel()
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [show, mode])

      if (!show) return null

      const act = async (ids, action) => {
        if (busy || !ids.length) return
        setBusy(true)
        setNotice(null)
        try {
          const res = await call('dsh-soul-memory/pending', { action, ids })
          const result = (res && res.result) || {}
          const done = action === 'approve'
            ? (Array.isArray(result.applied) ? result.applied.length : 0)
            : (typeof result.removed === 'number' ? result.removed : ids.length)
          const failed = Array.isArray(result.failed) ? result.failed.length : 0
          const tone = failed || result.cleanupError ? 'error' : 'ok'
          const extra = failed
            ? '，' + failed + ' 条失败：' + result.failed[0].error
            : result.cleanupError
              ? '，但待批列表没清掉：' + result.cleanupError
              : ''
          setNotice({
            tone,
            text: (action === 'approve' ? '已批准 ' + done + ' 条' : '已丢弃 ' + done + ' 条') + extra,
          })
          await store.refresh({ force: true })
        } catch (error) {
          setNotice({ tone: 'error', text: String(error.message || error) })
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'dsm-root dsm-layer', 'data-mode': mode === 'overlay' ? 'overlay' : 'sidebar' },
        h('div', { role: 'dialog', 'aria-modal': 'false', 'aria-label': '待批规则', className: 'dsm-panel' },
          h('div', { className: 'dsm-panel-head' },
            h('div', null,
              h('h4', null, '灵魂记忆 · 待批区'),
              h('div', { className: 'dsm-panel-sub' }, pending.length ? pending.length + ' 条规则等你确认' : '暂无待批规则'),
            ),
            h('button', { type: 'button', className: 'dsm-close', onClick: close, 'aria-label': '关闭' }, '×'),
          ),
          notice ? h(Banner, { tone: notice.tone }, notice.text) : null,
          pending.length === 0
            ? h(Empty, null, '模型归纳的规则会先停在这里，你批准后才生效。')
            : h('div', { className: 'dsm-list' },
              pending.map((item) => h('div', { key: item.id, className: 'dsm-item' },
                h('div', { className: 'dsm-item-text' }, item.text),
                item.why ? h('div', { className: 'dsm-meta' }, '为什么：', item.why) : null,
                h('div', { className: 'dsm-row', style: { marginTop: 8 } },
                  h(Button, { tone: 'primary', disabled: busy, onClick: () => act([item.id], 'approve') }, '批准'),
                  h(Button, { tone: 'danger', disabled: busy, onClick: () => act([item.id], 'reject') }, '丢弃'),
                ),
              )),
            ),
          pending.length ? h('div', { className: 'dsm-row', style: { marginTop: 12 } },
            h(Button, { tone: 'primary', disabled: busy, onClick: () => act(pending.map((x) => x.id), 'approve') }, '全部批准'),
            h(Button, { tone: 'danger', disabled: busy, onClick: () => act(pending.map((x) => x.id), 'reject') }, '全部丢弃'),
          ) : null,
        ),
      )
    }

    // ---------------------------------------------------------------- 注册
    return {
      name: 'dsh-soul-memory',
      inject: ['slots'],
      apply(ctx) {
        // 样式文件在热重载时会被重新执行，交给 effect 管理清理。
        ctx.effect(() => ensureStyle())

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'soul-memory',
          order: 60,
          label: () => '灵魂记忆',
        }, (props) => h(ErrorGuard, null, h(SoulSection, props))))

        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon',
          id: 'soul-memory',
          order: 60,
        }, SoulIcon))

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'soul-memory-inline',
          order: 30,
        }, (props) => h(ErrorGuard, null, h(InlineNotice, props))))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'soul-memory-floating',
          order: 40,
        }, (props) => h(ErrorGuard, null, h(FloatingPanel, props))))
      },
    }
  },
})
