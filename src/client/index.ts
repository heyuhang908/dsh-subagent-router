import { useEffect } from 'react'

/**
 * @dsh-external/dsh-subagent-routing-console — client 侧栏常驻面板。
 *
 * 挂载方式：直接 DOM 挂载到侧栏列（绕过 slot 系统——conversation.view 是
 * session-scope 且空白会话时整个视图区不渲染，导致「会话开始前不可见」；
 * 侧栏常驻才能做到会话开始前设置全局默认）。参照 activity-heatmap 已验证的
 * 侧栏挂载模式：选择器候选 + MutationObserver 等待 shell 渲染并自愈。
 *
 * 面板结构（自上而下）：
 *  1. 头：托管状态 + 保存路由按钮/状态 + 改写统计 + 折叠按钮
 *  2. 当前生效路由摘要（常驻可见，含通道预览选择器、结果、来源、紧凑优先级链）
 *  3. 范围 Tabs：本会话 / 全局默认 / 通道规则 / 活动监控（仅选中面板展开）
 */
type ClientContext = {
  effect(fn: () => void | (() => void), label?: string): void
  logger?: { warn?: (...args: unknown[]) => void }
}

// 模块契约：apply(ctx) 注入的服务声明。
// 说明：面板走侧栏 DOM 挂载（绕过 slot 系统），不用 slots 服务本身；但保留声明
// 以满足模块加载器与 dsh-super-injector 骨架扫描器的惯例（slots 服务在客户端
// 运行时始终存在，声明无害）。见下方 apply 内的 sidebar.footer.action 空条目锚点。
export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  ensureCss()
  // 扫描器锚点：注册一个空 sidebar.footer.action 条目（组件返回 null，无副作用），
  // 满足 dsh-super-injector 对 client 骨架的 REGISTER_NAME 校验。真实面板走下方 DOM 挂载。
  ;(ctx as any).slots.inject('sidebar.footer.action', () =>
    (ctx as any).slots.register({ name: 'sidebar.footer.action', id: 'dsh-subagent-routing-console-anchor' }, () => null),
  )
  // Session-scope slot supplies the actual top-level conversation id. The
  // floater UI was removed; a null-rendering tracker keeps broadcasting the
  // session id to the sidebar panel (CURRENT_SESSION_EVENT).
  ;(ctx as any).slots.inject('conversation.input.dock', () =>
    (ctx as any).slots.register({ name: 'conversation.input.dock', id: 'dsh-subagent-routing-console-session-tracker', order: 15 }, SessionIdTracker),
  )
  // 面板控制器生命周期交给 ctx.effect（卸载时清 timers/observers）。
  ctx.effect(() => {
    const panel = createPanel(ctx)
    panel.start()
    return () => panel.dispose()
  }, 'dsh-subagent-routing-console: sidebar panel')
}

// ──────────────────────────────── 数据模型 ────────────────────────────────

interface OverrideSpec {
  provider?: string
  model?: string
  effort?: string
}
interface Policy {
  enabled: boolean
  defaultOverride: OverrideSpec
  sessionOverrides: Record<string, OverrideSpec>
  rules: Array<{ channel: string; override: OverrideSpec }>
  presets: Record<string, { label: string; override: OverrideSpec }>
}
interface CatalogModel {
  id: string
  name: string
  efforts: readonly string[]
  defaultEffort?: string
}
interface State {
  ok: boolean
  policy: Policy
  catalog: Array<{ name: string; models: CatalogModel[] }>
  channels: string[]
  children: Array<{
    sessionId: string
    channel: string
    startedAt: number
    endedAt?: number
    stopReason?: string
    lastRoute?: { provider: string; model: string; effort?: string; rewritten: boolean }
    note?: string
  }>
  topSessions: Array<{ id: string; title?: string }>
  stats: { rewrites: number; trackedActive: number }
}

const CURRENT_SESSION_EVENT = 'dsh-subagent-routing-console:current-session'
let activeSessionId = ''

type SessionSlotProps = { sessionId?: unknown }

// 悬浮窗（本会话路由浮层）已移除。保留一个空渲染 tracker：会话视图挂载时向
// 侧栏面板广播当前顶层会话 ID（面板「本会话」Tab 依赖 CURRENT_SESSION_EVENT）。
function SessionIdTracker({ sessionId: rawSessionId }: SessionSlotProps): any {
  const sessionId = typeof rawSessionId === 'string' ? rawSessionId : String(rawSessionId ?? '')
  useEffect(() => {
    if (!sessionId) return
    activeSessionId = sessionId
    window.dispatchEvent(new CustomEvent(CURRENT_SESSION_EVENT, { detail: { sessionId } }))
    return () => {
      if (activeSessionId !== sessionId) return
      activeSessionId = ''
      window.dispatchEvent(new CustomEvent(CURRENT_SESSION_EVENT, { detail: { sessionId: '' } }))
    }
  }, [sessionId])
  return null
}

const PANEL_ID = 'dsh-subagent-routing-console-panel'
const CSS_ID = 'dsh-subagent-routing-console-css'
const COMMON_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

const CSS = `
#${PANEL_ID} { font-size: 12px; color: var(--dsw-alias-label-primary, inherit); padding: 10px; border-top: 1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.2)); display:flex; flex-direction:column; gap:10px; background: var(--dsw-alias-bg-layer-1, transparent); }
#${PANEL_ID} .sr-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-weight:600; }
#${PANEL_ID} .sr-head-main { display:flex; align-items:center; gap:8px; flex:1 1 auto; min-width:0; }
#${PANEL_ID} .sr-enable { display:flex; align-items:center; gap:6px; font-weight:600; cursor:pointer; user-select:none; font-size:12px; }
#${PANEL_ID} .sr-enable input[type="checkbox"] { width:14px; height:14px; accent-color: var(--dsw-alias-accent, #40c463); }
#${PANEL_ID} .sr-status { display:inline-flex; align-items:center; gap:4px; padding:2px 8px; border-radius:999px; font-size:11px; font-weight:600; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.25)); line-height:1.2; }
#${PANEL_ID} .sr-status.running { background: rgba(64,196,99,.12); border-color: rgba(64,196,99,.35); color:#2ea043; }

#${PANEL_ID} .sr-stat { opacity:.65; font-weight:400; font-size:11px; white-space:nowrap; }
#${PANEL_ID} .sr-save { cursor:pointer; border:1px solid var(--dsw-alias-accent, #0969da); background: var(--dsw-alias-accent, #0969da); color:#fff; border-radius:6px; padding:3px 9px; font-size:11px; font-weight:600; line-height:1.3; }
#${PANEL_ID} .sr-save:hover { filter:brightness(.94); }
#${PANEL_ID} .sr-save:disabled { opacity:.45; cursor:not-allowed; filter:none; }
#${PANEL_ID} .sr-save-state { font-size:10px; opacity:.7; }
#${PANEL_ID} .sr-save-state.error { color:#cf222e; opacity:1; }
#${PANEL_ID} .sr-collapse { margin-left:auto; cursor:pointer; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.08)); color:inherit; border-radius:6px; padding:2px 8px; font-size:11px; line-height:1.4; }
#${PANEL_ID} .sr-collapse:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); }
#${PANEL_ID} .sr-collapse:focus-visible, #${PANEL_ID} button:focus-visible, #${PANEL_ID} select:focus-visible, #${PANEL_ID} input:focus-visible, #${PANEL_ID} summary:focus-visible { outline:2px solid var(--dsw-alias-accent, #0969da); outline-offset:2px; }
#${PANEL_ID} .sr-summary { border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.18)); background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.06)); border-radius:8px; padding:8px 10px; display:flex; flex-direction:column; gap:6px; }
#${PANEL_ID} .sr-summary-head { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
#${PANEL_ID} .sr-summary-title { font-weight:700; font-size:12px; }
#${PANEL_ID} .sr-summary-channel { margin-left:auto; display:flex; align-items:center; gap:4px; font-size:11px; }
#${PANEL_ID} .sr-summary-channel select { max-width:120px; }
#${PANEL_ID} .sr-summary-main { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#${PANEL_ID} .sr-summary-route { font-weight:700; font-size:12px; word-break:break-all; }
#${PANEL_ID} .sr-summary-route.inherit { opacity:.55; font-weight:400; }
#${PANEL_ID} .sr-summary-source { display:inline-flex; align-items:center; padding:1px 7px; border-radius:999px; font-size:10px; font-weight:600; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.6)); line-height:1.4; }

#${PANEL_ID} .sr-summary-source[data-source="session"] { color:#0969da; border-color: rgba(9,105,218,.3); background: rgba(9,105,218,.08); }
#${PANEL_ID} .sr-summary-source[data-source="channel"] { color:#8250df; border-color: rgba(130,80,223,.3); background: rgba(130,80,223,.08); }
#${PANEL_ID} .sr-summary-source[data-source="global"] { color:#1a7f37; border-color: rgba(26,127,55,.3); background: rgba(26,127,55,.08); }
#${PANEL_ID} .sr-summary-source[data-source="inherit"] { opacity:.6; }
#${PANEL_ID} .sr-summary-chain { font-size:10px; opacity:.7; line-height:1.4; word-break:break-all; }
#${PANEL_ID} .sr-summary-explain { font-size:10.5px; opacity:.68; line-height:1.4; }
#${PANEL_ID} .sr-tabs { display:flex; gap:4px; flex-wrap:wrap; border-bottom:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.16)); padding-bottom:5px; }
#${PANEL_ID} button.sr-tab { cursor:pointer; border:1px solid transparent; background:transparent; color:inherit; border-radius:6px; padding:3px 9px; font-size:11px; font-weight:500; opacity:.75; line-height:1.3; }
#${PANEL_ID} button.sr-tab[aria-selected="true"] { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.14)); border-color: var(--dsw-alias-border-subtle, rgba(128,128,128,.3)); opacity:1; font-weight:700; }
#${PANEL_ID} button.sr-tab:hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.1)); opacity:1; }
#${PANEL_ID} .sr-panels { display:flex; flex-direction:column; gap:8px; }
#${PANEL_ID} .sr-panel { display:flex; flex-direction:column; gap:6px; }
#${PANEL_ID} .sr-panel[hidden] { display:none !important; }
#${PANEL_ID} .sr-chips { display:flex; flex-wrap:wrap; gap:5px; }
#${PANEL_ID} button.sr-chip { cursor:pointer; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); background:transparent; color:inherit; border-radius:999px; padding:3px 10px; font-size:11px; line-height:1.3; }
#${PANEL_ID} button.sr-chip[aria-pressed="true"] { background: var(--dsw-alias-accent, #0969da); color:#fff; border-color: transparent; font-weight:600; }
#${PANEL_ID} button.sr-chip:not([aria-pressed="true"]):hover { background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.12)); }
#${PANEL_ID} button.sr-chip:disabled { opacity:.45; cursor:not-allowed; }
#${PANEL_ID} .sr-label { opacity:.65; min-width:56px; display:inline-block; font-size:11px; font-weight:500; }
#${PANEL_ID} select, #${PANEL_ID} input[type="text"] { max-width:168px; font-size:11px; background: var(--dsw-alias-bg-layer-2, transparent); color:inherit; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); border-radius:6px; padding:3px 6px; }
#${PANEL_ID} select:disabled { opacity:.5; cursor:not-allowed; }
#${PANEL_ID} .sr-row { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }
#${PANEL_ID} .sr-section { display:flex; flex-direction:column; gap:6px; }
#${PANEL_ID} .sr-title { font-weight:700; font-size:11px; opacity:.85; letter-spacing:.02em; }
#${PANEL_ID} .sr-badge { display:inline-flex; align-items:center; padding:1px 6px; border-radius:999px; font-size:10px; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.35)); opacity:.85; line-height:1.3; white-space:nowrap; }
#${PANEL_ID} .sr-badge.rewrite { border-color:#1a7f37; color:#1a7f37; background: rgba(64,196,99,.1); }
#${PANEL_ID} .sr-badge.inherit { opacity:.55; }
#${PANEL_ID} .sr-child { display:flex; gap:6px; align-items:center; padding:5px 7px; flex-wrap:wrap; border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.14)); border-radius:7px; background: var(--dsw-alias-bg-layer-1, rgba(255,255,255,.02)); }
#${PANEL_ID} .sr-child + .sr-child { margin-top:1px; }
#${PANEL_ID} .sr-child-channel { font-weight:600; }
#${PANEL_ID} .sr-child-route { opacity:.8; font-size:10.5px; word-break:break-all; }
#${PANEL_ID} .sr-child-session { opacity:.6; font-size:10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
#${PANEL_ID} .sr-child-duration { opacity:.55; font-size:10px; margin-left:auto; white-space:nowrap; }
#${PANEL_ID} .sr-note { color:#9a6700; font-size:10px; background: rgba(212,167,44,.14); border-radius:4px; padding:1px 5px; border:1px solid rgba(212,167,44,.25); word-break:break-all; }
#${PANEL_ID} .sr-empty { opacity:.72; font-size:11px; line-height:1.5; padding:8px 10px; border:1px dashed var(--dsw-alias-border-subtle, rgba(128,128,128,.25)); border-radius:7px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.04)); }

#${PANEL_ID} details.sr-details { border:1px solid var(--dsw-alias-border-subtle, rgba(128,128,128,.2)); border-radius:6px; padding:4px 8px; background: var(--dsw-alias-bg-layer-2, rgba(128,128,128,.04)); }
#${PANEL_ID} details.sr-details summary { cursor:pointer; font-size:11px; opacity:.75; list-style:none; user-select:none; }
#${PANEL_ID} details.sr-details summary::-webkit-details-marker { display:none; }
#${PANEL_ID} details.sr-details summary::before { content:"▸ "; font-size:9px; opacity:.6; }
#${PANEL_ID} details.sr-details[open] summary::before { content:"▾ "; }
#${PANEL_ID} .sr-hint { opacity:.62; font-size:10.5px; line-height:1.45; }
@media (max-width: 420px) { #${PANEL_ID} select, #${PANEL_ID} input[type="text"] { max-width:100%; flex:1 1 120px; } #${PANEL_ID} .sr-row { gap:4px; } }
#${PANEL_ID}.sr-collapsed .sr-tabs, #${PANEL_ID}.sr-collapsed .sr-panels { display:none !important; }
`

function ensureCss(): void {
  const existing = document.getElementById(CSS_ID) as HTMLStyleElement | null
  if (existing) {
    // HMR keeps the style node alive; refresh its text so visual changes apply immediately.
    existing.textContent = CSS
    return
  }
  const tag = document.createElement('style')
  tag.id = CSS_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}

// ──────────────────────────────── 数据访问 ────────────────────────────────

async function getState(): Promise<State | null> {
  try {
    const res = await fetch('/subagent-routing-console/state', { cache: 'no-store' })
    if (!res.ok) return null
    return (await res.json()) as State
  } catch {
    return null
  }
}

interface PutPolicyResult {
  state: State | null
  error?: string
}

async function putPolicy(policy: unknown): Promise<PutPolicyResult> {
  try {
    const res = await fetch('/subagent-routing-console/policy', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(policy),
    })
    if (!res.ok) {
      let error = '服务器拒绝了保存'
      try {
        const body = (await res.json()) as { error?: unknown }
        if (typeof body.error === 'string' && body.error) error = body.error
      } catch {
        // keep the generic HTTP error
      }
      return { state: null, error }
    }
    return { state: (await res.json()) as State }
  } catch {
    return { state: null, error: '无法连接路由台 host' }
  }
}

// ──────────────────────────────── DOM 辅助 ────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean>,
  ...children: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'boolean') {
        if (value) node.setAttribute(key, '')
      } else {
        node.setAttribute(key, value)
      }
    }
  }
  for (const child of children) {
    if (child === null || child === undefined) continue
    node.append(child)
  }
  return node
}

function fmtDuration(from: number, to?: number): string {
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000))
  if (s < 60) return s + 's'
  return Math.floor(s / 60) + 'm' + (s % 60) + 's'
}

function statsText(s: State): string {
  return `改写 ${s.stats.rewrites} 次 · 活动 ${s.stats.trackedActive}`
}

function isEmptyOv(o: OverrideSpec): boolean {
  return !o.provider && !o.model && !o.effort
}

function describeOv(o: OverrideSpec): string {
  const parts: string[] = []
  if (o.provider && o.model) parts.push(o.provider + '/' + o.model)
  else if (o.provider) parts.push(o.provider)
  parts.push('强度: ' + (o.effort || '默认'))
  return parts.join(' · ')
}

function isEqualOv(a: OverrideSpec, b: OverrideSpec): boolean {
  return (a.provider ?? '') === (b.provider ?? '') && (a.model ?? '') === (b.model ?? '') && (a.effort ?? '') === (b.effort ?? '')
}

function clonePresets(src: Policy['presets']): Policy['presets'] {
  return Object.fromEntries(Object.entries(src).map(([k, v]) => [k, { label: v.label, override: { ...v.override } }])) as Policy['presets']
}

function allChannelUnion(s: State): string[] {
  return Array.from(new Set(['spawn', ...s.channels, ...s.policy.rules.map((r) => r.channel)]))
}

function normalizePreviewChannel(s: State, cur: string): string {
  if (!cur) return 'spawn'
  const avail = new Set(allChannelUnion(s))
  return avail.has(cur) ? cur : 'spawn'
}

// ──────────────────────────────── 侧栏挂载（参照 heatmap 模式） ────────────────────────────────

const COLUMN_SELECTORS = ['[data-pane="sidebar"]', '[class*="sidebarCol"]', '[class*="sidebar-column"]']

function sidebarRoot(): HTMLElement | undefined {
  let column: HTMLElement | null = null
  for (const selector of COLUMN_SELECTORS) {
    column = document.querySelector<HTMLElement>(selector)
    if (column !== null) break
  }
  if (column === null) return undefined
  const anchor = column.querySelector<HTMLElement>('[class*="logoRow"]')
  if (anchor?.parentElement) return anchor.parentElement
  return column.firstElementChild ? (column.firstElementChild as HTMLElement) : column
}

// ──────────────────────────────── 面板控制器 ────────────────────────────────

type TabId = 'session' | 'global' | 'channel' | 'activity'

function createPanel(_ctx: ClientContext) {
  const root = el('div', { id: PANEL_ID })
  root.textContent = '子代理路由台加载中…'
  let state: State | null = null
  let draftPolicy: Policy | null = null
  let dirty = false
  let saving = false
  let saveMessage = ''
  let currentSessionId = activeSessionId
  let selectedSession = currentSessionId
  let previewChannel = ''
  let selectedTab: TabId = 'session'
  let collapsed = false
  let hoverPaused = false
  let disposed = false
  let timer = 0
  let rootObserver: MutationObserver | undefined
  let waitObserver: MutationObserver | undefined

  const displayState = (): State | null => {
    if (!state) return null
    return draftPolicy ? { ...state, policy: draftPolicy } : state
  }

  const renderAll = (): void => {
    const view = displayState()
    if (!view) return
    root.replaceChildren(buildBody(view))
    if (collapsed) root.classList.add('sr-collapsed')
    else root.classList.remove('sr-collapsed')
  }

  const onCurrentSession = (event: Event): void => {
    const detail = (event as CustomEvent<{ sessionId?: unknown }>).detail
    const next = typeof detail?.sessionId === 'string' ? detail.sessionId.trim() : ''
    if (next === currentSessionId && selectedSession === next) return
    currentSessionId = next
    selectedSession = next
    if (state) renderAll()
  }
  window.addEventListener(CURRENT_SESSION_EVENT, onCurrentSession)

  /** Refresh live activity while preserving an unsaved draft. */
  const renderLight = (): void => {
    const view = displayState()
    if (!view) return
    const stat = root.querySelector('.sr-stat')
    if (stat) stat.textContent = statsText(view)
    const statusEl = root.querySelector('.sr-status')
    if (statusEl) {
      statusEl.textContent = '路由托管'
      statusEl.className = 'sr-status running'
    }
    const saveBtn = root.querySelector('[data-role="save"]') as HTMLButtonElement | null
    if (saveBtn) {
      saveBtn.disabled = !dirty || saving
      saveBtn.textContent = saving ? '保存中…' : '保存路由'
    }
    const saveState = root.querySelector('[data-role="save-state"]')
    if (saveState) {
      saveState.textContent = saveMessage
      saveState.className = 'sr-save-state' + (saveMessage.includes('失败') ? ' error' : '')
    }
    const collapseBtn = root.querySelector('.sr-collapse')
    if (collapseBtn) {
      collapseBtn.setAttribute('aria-expanded', String(!collapsed))
      collapseBtn.setAttribute('aria-label', collapsed ? '展开面板' : '折叠面板')
      const label = collapsed ? '展开 ▸' : '折叠 ▾'
      if (collapseBtn.textContent !== label) collapseBtn.textContent = label
    }
    if (collapsed) root.classList.add('sr-collapsed')
    else root.classList.remove('sr-collapsed')
    const summaryRoute = root.querySelector('[data-role="summary-route"]')
    const summarySource = root.querySelector('[data-role="summary-source"]')
    const summaryChain = root.querySelector('[data-role="summary-chain"]')
    const summaryExplain = root.querySelector('[data-role="summary-explain"]')
    if (summaryRoute && summarySource && summaryChain && summaryExplain) {
      const info = computeEffective(view, previewChannel || (view.channels[0] ?? 'spawn'), selectedSession)
      summaryRoute.textContent = info.human
      summaryRoute.className = info.override ? 'sr-summary-route' : 'sr-summary-route inherit'
      summarySource.textContent = info.sourceLabel
      summarySource.setAttribute('data-source', info.sourceKey)
      summaryChain.textContent = info.chain
      summaryExplain.textContent = info.description
    }
    const list = root.querySelector('[data-role=children]')
    if (list) list.replaceChildren(...buildChildrenList(view))
  }

  const tick = async (): Promise<void> => {
    if (disposed || hoverPaused) return
    const next = await getState()
    if (disposed) return
    if (!next) return
    if (dirty) {
      state = { ...next, policy: draftPolicy! }
      previewChannel = normalizePreviewChannel(next, previewChannel)
      renderLight()
      return
    }
    const policyChanged = JSON.stringify(next.policy) !== JSON.stringify(state?.policy)
    const channelsChanged = JSON.stringify(next.channels) !== JSON.stringify(state?.channels)
    previewChannel = normalizePreviewChannel(next, previewChannel)
    // The current conversation is supplied by the session-scoped slot. Do not
    // silently bind the panel to the first historical session in the list.
    const needReset = !sanitizeSameSessionSet(next)
    if (policyChanged || channelsChanged || needReset) {
      if (!currentSessionId && selectedSession && !next.policy.sessionOverrides[selectedSession]) {
        const stillKnown = next.topSessions?.some((session) => session.id === selectedSession) ?? false
        if (!stillKnown) selectedSession = ''
      }
      state = next
      renderAll()
      return
    }
    state = next
    // If enabled flag toggled externally but policy string compare missed due to timing, force full render to keep switch in sync.
    // policyChanged already covers enabled changes; remaining lightweight path keeps enable/ collapse aria synchronized via renderLight.
    renderLight()
  }

  // 会话下拉变化时，若选中项不在新会话集则重置选中（轻量判断避免误全量重绘）。
  function sanitizeSameSessionSet(s: State): boolean {
    if (!selectedSession) return true
    if (selectedSession === currentSessionId) return true
    // if selectedSession has an override, consider it valid even if not live
    if (s.policy.sessionOverrides[selectedSession]) return true
    return s.topSessions?.some((x) => x.id === selectedSession) ?? true
  }

  const commit = (mutate: (policy: Policy) => void): void => {
    if (!state || saving) return
    // Edits stay local until the user explicitly saves them.
    const base = draftPolicy ?? state.policy
    const policy: Policy = {
      enabled: base.enabled,
      defaultOverride: { ...base.defaultOverride },
      sessionOverrides: Object.fromEntries(Object.entries(base.sessionOverrides).map(([k, v]) => [k, { ...v }])),
      rules: base.rules.map((r) => ({ channel: r.channel, override: { ...r.override } })),
      presets: clonePresets(base.presets),
    }
    mutate(policy)
    draftPolicy = policy
    dirty = true
    saveMessage = '有未保存更改'
    renderAll()
  }

  const saveDraft = async (): Promise<void> => {
    if (!state || !draftPolicy || saving) return
    saving = true
    saveMessage = '保存中…'
    renderAll()
    const result = await putPolicy(draftPolicy)
    saving = false
    if (!result.state) {
      saveMessage = '保存失败：' + (result.error ?? '运行策略未改变')
      renderAll()
      return
    }
    const next = result.state
    state = next
    draftPolicy = null
    dirty = false
    saveMessage = '已保存，后续子代理立即使用新路由'
    previewChannel = normalizePreviewChannel(next, previewChannel)
    renderAll()
  }

  const applyPresetTo = (scope: 'global' | 'session', override: OverrideSpec): void => {
    if (scope === 'session' && !selectedSession) return
    void commit((policy) => {
      policy.enabled = true
      if (scope === 'session' && selectedSession) {
        if (isEmptyOv(override)) delete policy.sessionOverrides[selectedSession]
        else policy.sessionOverrides[selectedSession] = { ...(policy.sessionOverrides[selectedSession] ?? {}), ...override }
      } else {
        policy.defaultOverride = { ...policy.defaultOverride, ...override }
      }
    })
  }

  const setField = (scope: 'global' | 'session', field: 'provider' | 'model' | 'effort', value: string): void => {
    if (scope === 'session' && !selectedSession) return
    void commit((policy) => {
      let target: OverrideSpec
      if (scope === 'session' && selectedSession) {
        target = { ...(policy.sessionOverrides[selectedSession] ?? {}) }
      } else {
        target = { ...policy.defaultOverride }
      }
      if (field === 'provider') {
        target.provider = value || undefined
        target.model = undefined
      } else if (field === 'model') {
        target.model = value || undefined
      } else {
        if (value) target.effort = value
        else delete target.effort
      }
      if (scope === 'session' && selectedSession) {
        if (isEmptyOv(target)) delete policy.sessionOverrides[selectedSession]
        else policy.sessionOverrides[selectedSession] = target
      } else {
        policy.defaultOverride = target
      }
    })
  }

  const setRuleField = (channel: string, field: 'provider' | 'model' | 'effort', value: string): void => {
    void commit((policy) => {
      let rule = policy.rules.find((r) => r.channel === channel)
      if (!rule) {
        rule = { channel, override: {} }
        policy.rules.push(rule)
      }
      const next: OverrideSpec = { ...rule.override }
      if (field === 'provider') {
        next.provider = value || undefined
        next.model = undefined
      } else if (field === 'model') {
        next.model = value || undefined
      } else {
        if (value) next.effort = value
        else delete next.effort
      }
      rule.override = next
      if (!next.provider && !next.model && !next.effort) {
        policy.rules = policy.rules.filter((r) => r !== rule)
      }
    })
  }

  const modelOptionsFor = (providerName: string): CatalogModel[] =>
    state?.catalog.find((p) => p.name === providerName)?.models ?? []

  const effortChoices = (providerName: string | undefined, modelId: string | undefined): string[] => {
    if (providerName && modelId) {
      const m = modelOptionsFor(providerName).find((x) => x.id === modelId)
      if (m && m.efforts.length) return [...m.efforts]
    }
    const all = new Set<string>(COMMON_EFFORTS)
    for (const p of state?.catalog ?? []) for (const m of p.models) for (const e of m.efforts) all.add(e)
    return [...all]
  }

  function buildProviderSelect(value: string | undefined, onchange: (v: string) => void, ariaLabel?: string, allowEmpty = true): HTMLSelectElement {
    const sel = el('select')
    if (ariaLabel) sel.setAttribute('aria-label', ariaLabel)
    if (allowEmpty) sel.append(el('option', { value: '' }, '(继承路由台全局默认)'))
    for (const p of state?.catalog ?? []) {
      if (!p.models.length) continue
      sel.append(el('option', { value: p.name }, p.name))
    }
    sel.value = value ?? ''
    sel.addEventListener('change', () => onchange(sel.value))
    return sel
  }

  function buildModelSelect(providerName: string | undefined, value: string | undefined, onchange: (v: string) => void, ariaLabel?: string, allowEmpty = true): HTMLSelectElement {
    const sel = el('select')
    if (ariaLabel) sel.setAttribute('aria-label', ariaLabel)
    if (allowEmpty) sel.append(el('option', { value: '' }, providerName ? '(继承路由台全局模型)' : '(随 provider)'))
    for (const m of modelOptionsFor(providerName ?? '')) {
      sel.append(el('option', { value: m.id }, m.name))
    }
    sel.value = value ?? ''
    sel.addEventListener('change', () => onchange(sel.value))
    return sel
  }

  function buildEffortSelect(providerName: string | undefined, modelId: string | undefined, value: string | undefined, onchange: (v: string) => void, ariaLabel?: string): HTMLSelectElement {
    const sel = el('select')
    if (ariaLabel) sel.setAttribute('aria-label', ariaLabel)
    sel.append(el('option', { value: '' }, '强度:默认'))
    for (const e of effortChoices(providerName, modelId)) {
      sel.append(el('option', { value: e }, '强度:' + e))
    }
    sel.value = value ?? ''
    sel.addEventListener('change', () => onchange(sel.value))
    return sel
  }

  function computeEffective(s: State, channel: string, sessionId: string): { sourceLabel: string; sourceKey: string; override: OverrideSpec | undefined; chain: string; description: string; human: string } {
    const policy = s.policy
    const merged: OverrideSpec = {}
    let sourceLabel = '路由台全局默认'
    let sourceKey = 'global'
    const applyLayer = (layer: OverrideSpec | undefined, label: string, key: string): void => {
      if (!layer || isEmptyOv(layer)) return
      if (layer.provider && layer.model) {
        merged.provider = layer.provider
        merged.model = layer.model
        sourceLabel = label
        sourceKey = key
      }
      if (layer.effort) {
        merged.effort = layer.effort
        if (sourceKey === 'inherit') {
          sourceLabel = label
          sourceKey = key
        }
      }
    }
    applyLayer(policy.defaultOverride, '全局默认', 'global')
    applyLayer(policy.rules.find((r) => r.channel === '*')?.override, '通道兜底', 'channel')
    applyLayer(policy.rules.find((r) => r.channel === channel)?.override, '通道规则', 'channel')
    applyLayer(sessionId ? policy.sessionOverrides[sessionId] : undefined, '会话覆盖', 'session')
    if (!isEmptyOv(merged)) {
      return {
        sourceLabel,
        sourceKey,
        override: merged,
        chain: '全局默认 → 通道兜底 → 通道规则 → 会话覆盖（按字段继承）',
        description: sourceKey === 'session'
          ? `会话 ${sessionId.slice(0, 8)} 的路由字段生效，其余字段继承通道/全局。`
          : '当前路由按字段从全局、通道到会话层继承。',
        human: describeOv(merged),
      }
    }
    return {
      sourceLabel: '待保存',
      sourceKey: 'inherit',
      override: undefined,
      chain: '请先选择完整的 provider + model，然后点击「保存路由」',
      description: '路由台要求保存完整的全局 provider + model；未保存前不会改变运行中的路由。',
      human: '未完成路由配置',
    }
  }

  function buildChildrenList(s: State): Node[] {
    if (!s.children.length) {
      return [
        el(
          'div',
          { class: 'sr-empty' },
          el('div', { style: 'font-weight:600;' }, '暂无子代理活动记录'),
          el('div', { style: 'opacity:.65;margin-top:2px;' }, '子代理启动后将在此显示通道、路由、会话、时长与备注。'),
        ),
      ]
    }
    return s.children.slice(0, 10).map((c) => {
      const isActive = !c.endedAt
      const statusBadge = isActive
        ? el('span', { class: 'sr-badge', style: 'border-color:#1a7f37;color:#1a7f37;background:rgba(64,196,99,.1);' }, '进行中')
        : el('span', { class: 'sr-badge', style: 'opacity:.6;' }, '已结束' + (c.stopReason ? '·' + c.stopReason.slice(0, 12) : ''))
      const rewriteBadge = c.lastRoute?.rewritten
        ? el('span', { class: 'sr-badge rewrite' }, '已路由')
        : el('span', { class: 'sr-badge inherit' }, '继承')
      const channelBadge = el('span', { class: 'sr-badge sr-child-channel' }, c.channel)
      const routeText = c.lastRoute
        ? c.lastRoute.provider + '/' + c.lastRoute.model + (c.lastRoute.effort ? ' · ' + c.lastRoute.effort : '')
        : undefined
      const row = el(
        'div',
        { class: 'sr-child' },
        channelBadge,
        statusBadge,
        rewriteBadge,
        el('span', { class: 'sr-child-session', title: c.sessionId }, c.sessionId.slice(0, 8)),
      )
      if (routeText) row.append(el('span', { class: 'sr-child-route' }, routeText))
      row.append(el('span', { class: 'sr-child-duration' }, (c.endedAt ? '✓ ' : '') + fmtDuration(c.startedAt, c.endedAt)))
      if (c.note) row.append(el('span', { class: 'sr-note' }, c.note))
      return row
    })
  }

  function buildHeader(s: State): HTMLElement {
    const status = el('span', { class: 'sr-status running', 'aria-live': 'polite' }, '路由托管')
    const stat = el('span', { class: 'sr-stat' }, statsText(s))
    const saveBtn = el('button', { class: 'sr-save', type: 'button', 'data-role': 'save' }, saving ? '保存中…' : '保存路由') as HTMLButtonElement
    saveBtn.disabled = !dirty || saving
    saveBtn.title = dirty ? '保存待应用的路由配置并立即生效' : '当前没有待保存更改'
    saveBtn.addEventListener('click', () => void saveDraft())
    const saveState = el('span', { class: 'sr-save-state' + (saveMessage.includes('失败') ? ' error' : ''), 'data-role': 'save-state', 'aria-live': 'polite' }, saveMessage)
    const collapseBtn = el(
      'button',
      {
        class: 'sr-collapse',
        type: 'button',
        'aria-label': collapsed ? '展开面板' : '折叠面板',
        'aria-expanded': String(!collapsed),
        'aria-controls': 'sr-panels',
      },
      collapsed ? '展开 ▸' : '折叠 ▾',
    )
    collapseBtn.addEventListener('click', () => {
      collapsed = !collapsed
      renderAll()
    })
    const headMain = el('div', { class: 'sr-head-main' }, el('span', { class: 'sr-enable' }, '子代理路由台'), status)
    return el('div', { class: 'sr-head' }, headMain, stat, saveBtn, saveState, collapseBtn)
  }

  function buildSummary(s: State): HTMLElement {
    // selector uses union including implicit `spawn` + live channels + orphan persisted rules
    previewChannel = normalizePreviewChannel(s, previewChannel)
    const allForPreview = allChannelUnion(s)
    const info = computeEffective(s, previewChannel, selectedSession)
    const sel = el('select', { 'aria-label': '预览通道' }) as HTMLSelectElement
    const uniq = Array.from(new Set([previewChannel, ...allForPreview]))
    for (const ch of uniq) sel.append(el('option', { value: ch }, ch))
    sel.value = previewChannel
    sel.addEventListener('change', () => {
      previewChannel = sel.value
      renderAll()
    })
    const head = el(
      'div',
      { class: 'sr-summary-head' },
      el('span', { class: 'sr-summary-title' }, '当前生效路由'),
      el('label', { class: 'sr-summary-channel' }, el('span', { style: 'opacity:.6;font-size:10px;' }, '通道'), sel),
    )
    const main = el(
      'div',
      { class: 'sr-summary-main' },
      el('span', { class: info.override ? 'sr-summary-route' : 'sr-summary-route inherit', 'data-role': 'summary-route' }, info.human),
      el('span', { class: 'sr-summary-source', 'data-source': info.sourceKey, 'data-role': 'summary-source' }, info.sourceLabel),
    )
    const chain = el('div', { class: 'sr-summary-chain', 'data-role': 'summary-chain' }, info.chain)
    const explain = el('div', { class: 'sr-summary-explain', 'data-role': 'summary-explain' }, info.description)
    return el('div', { class: 'sr-summary', 'data-role': 'summary' }, head, main, chain, explain)
  }

  function buildTabs(): HTMLElement {
    const tabDefs: Array<{ id: TabId; label: string }> = [
      { id: 'session', label: '本会话' },
      { id: 'global', label: '全局默认' },
      { id: 'channel', label: '通道规则' },
      { id: 'activity', label: '活动监控' },
    ]
    const list = el('div', { class: 'sr-tabs', role: 'tablist', 'aria-label': '路由配置范围' })
    for (const t of tabDefs) {
      const isSelected = selectedTab === t.id
      const btn = el(
        'button',
        {
          class: 'sr-tab',
          role: 'tab',
          id: `sr-tab-${t.id}`,
          'aria-selected': String(isSelected),
          'aria-controls': `sr-panel-${t.id}`,
          type: 'button',
          tabindex: isSelected ? '0' : '-1',
        },
        t.label,
      )
      btn.addEventListener('click', () => {
        selectedTab = t.id
        renderAll()
      })
      list.append(btn)
    }
    return list
  }

  function buildSessionPanel(s: State): HTMLElement {
    const policy = s.policy
    const sessions = s.topSessions ?? []
    const existingKeys = Object.keys(policy.sessionOverrides)
    const sel = el('select', { 'aria-label': '选择会话' }) as HTMLSelectElement
    sel.append(el('option', { value: '' }, sessions.length ? '(选择会话)' : '(暂无会话)'))
    for (const sess of sessions) {
      const title = typeof sess.title === 'string' ? sess.title.trim() : ''
      const label = title ? `${title} — ${sess.id.slice(0, 8)}` : sess.id
      sel.append(el('option', { value: sess.id }, sess.id === currentSessionId ? label + ' (当前)' : label))
    }
    for (const key of existingKeys) {
      if (!sessions.some((x) => x.id === key)) {
        sel.append(el('option', { value: key }, `${key.slice(0, 12)} (已配置)`))
      }
    }
    if (selectedSession && !sessions.some((x) => x.id === selectedSession) && !existingKeys.includes(selectedSession)) {
      sel.append(el('option', { value: selectedSession }, `${selectedSession.slice(0, 12)} (手动)`))
    }
    sel.value = selectedSession
    sel.addEventListener('change', () => {
      selectedSession = sel.value
      renderAll()
    })
    const currentOv = selectedSession ? policy.sessionOverrides[selectedSession] : undefined
    const ov = currentOv ?? {}
    const noSession = !selectedSession
    const providerSel = buildProviderSelect(ov.provider, (v) => setField('session', 'provider', v), '会话 provider')
    const modelSel = buildModelSelect(ov.provider, ov.model, (v) => setField('session', 'model', v), '会话模型')
    const effortSel = buildEffortSelect(ov.provider, ov.model, ov.effort, (v) => setField('session', 'effort', v), '会话强度')
    if (noSession) {
      providerSel.disabled = true
      modelSel.disabled = true
      effortSel.disabled = true
      providerSel.setAttribute('aria-disabled', 'true')
      modelSel.setAttribute('aria-disabled', 'true')
      effortSel.setAttribute('aria-disabled', 'true')
    }
    const row = el(
      'div',
      { class: 'sr-row' },
      el('span', { class: 'sr-label' }, '会话覆盖'),
      providerSel,
      modelSel,
      effortSel,
    )
    const clearBtn = el('button', { class: 'sr-chip', type: 'button' }, selectedSession ? '清除该会话覆盖' : '清除当前')
    if (noSession) {
      clearBtn.disabled = true
      clearBtn.setAttribute('aria-disabled', 'true')
      clearBtn.title = '当前没有识别到会话；打开一个会话后会自动绑定'
    }
    clearBtn.addEventListener('click', () => applyPresetTo('session', {}))
    const sessionHint = el(
      'div',
      { class: 'sr-hint' },
      noSession
        ? '当前没有可绑定的会话；打开一个会话后会自动绑定。'
        : selectedSession && currentOv && !isEmptyOv(currentOv)
          ? (selectedSession === currentSessionId ? '当前会话 ' : '会话 ') + selectedSession.slice(0, 10) + ' 覆盖生效 → ' + describeOv(currentOv)
          : selectedSession
            ? (selectedSession === currentSessionId ? '当前会话未设置覆盖：委派按通道规则/路由台全局默认。' : '未设置：该会话的委派按通道规则/路由台全局默认。')
            : '打开一个会话后，本会话覆盖会自动绑定到当前对话。',
    )
    const manualInput = el('input', { type: 'text', placeholder: '会话 ID…', style: 'width:140px;', 'aria-label': '手动输入会话 ID' }) as HTMLInputElement
    const manualBtn = el('button', { class: 'sr-chip', type: 'button' }, '应用')
    manualBtn.addEventListener('click', () => {
      const id = manualInput.value.trim()
      if (!id) return
      selectedSession = id
      manualInput.value = ''
      renderAll()
    })
    manualInput.addEventListener('keydown', (e) => {
      if ((e as KeyboardEvent).key !== 'Enter') return
      const id = manualInput.value.trim()
      if (!id) return
      selectedSession = id
      manualInput.value = ''
      renderAll()
    })
    const details = el(
      'details',
      { class: 'sr-details' },
      el('summary', {}, '高级：手动输入会话 ID'),
      el('div', { class: 'sr-row', style: 'margin-top:6px;' }, manualInput, manualBtn),
    )
    const panel = el(
      'div',
      { class: 'sr-panel', 'data-panel': 'session' },
      el('div', { class: 'sr-title' }, '本会话'),
      el('div', { class: 'sr-row' }, sel),
      row,
      el('div', { class: 'sr-row' }, clearBtn),
      sessionHint,
      details,
    )
    return panel
  }

  function buildGlobalPanel(s: State): HTMLElement {
    const policy = s.policy
    const chips = el('div', { class: 'sr-chips' })
    for (const [key, preset] of Object.entries(policy.presets)) {
      if (key === 'inherit') continue
      const active = isEqualOv(policy.defaultOverride, preset.override)
      const chip = el('button', { class: 'sr-chip', type: 'button', 'aria-pressed': String(active), 'data-preset': key }, preset.label)
      chip.addEventListener('click', () => applyPresetTo('global', preset.override))
      chips.append(chip)
    }
    const chipHint = el('div', { class: 'sr-hint' }, '预设先进入草稿；点击「保存路由」后写盘并立即生效。')
    const def = policy.defaultOverride
    const defRow = el(
      'div',
      { class: 'sr-row' },
      el('span', { class: 'sr-label' }, '全局默认'),
      buildProviderSelect(def.provider, (v) => setField('global', 'provider', v), '全局 provider', false),
      buildModelSelect(def.provider, def.model, (v) => setField('global', 'model', v), '全局模型', false),
      buildEffortSelect(def.provider, def.model, def.effort, (v) => setField('global', 'effort', v), '全局强度'),
    )
    const defHint = el(
      'div',
      { class: 'sr-hint' },
      isEmptyOv(def)
        ? '必须选择完整的 provider 与 model；保存后所有未覆盖的子代理都使用此路由台默认。'
        : '待保存/生效中 → ' + describeOv(def),
    )
    return el('div', { class: 'sr-panel', 'data-panel': 'global' }, el('div', { class: 'sr-title' }, '全局默认'), chips, chipHint, defRow, defHint)
  }

  function buildChannelPanel(s: State): HTMLElement {
    const allChannels = allChannelUnion(s)
    const rulesWrap = el('div', { class: 'sr-section' })
    if (!allChannels.length) {
      rulesWrap.append(el('div', { class: 'sr-empty' }, '暂无通道'))
    }
    for (const channel of allChannels) {
      const rule = policyLookup(s.policy, channel)
      const ov = rule?.override ?? {}
      const row = el(
        'div',
        { class: 'sr-row', style: 'margin-top:2px;' },
        el('span', { class: 'sr-label' }, '通道 ' + channel),
        buildProviderSelect(ov.provider, (v) => setRuleField(channel, 'provider', v), `通道 ${channel} provider`),
        buildModelSelect(ov.provider, ov.model, (v) => setRuleField(channel, 'model', v), `通道 ${channel} 模型`),
        buildEffortSelect(ov.provider, ov.model, ov.effort, (v) => setRuleField(channel, 'effort', v), `通道 ${channel} 强度`),
      )
      rulesWrap.append(row)
    }
    return el('div', { class: 'sr-panel', 'data-panel': 'channel' }, el('div', { class: 'sr-title' }, '按通道规则'), rulesWrap)
  }

  function policyLookup(policy: Policy, channel: string): { channel: string; override: OverrideSpec } | undefined {
    return policy.rules.find((r) => r.channel === channel)
  }

  function buildActivityPanel(s: State): HTMLElement {
    const list = el('div', { 'data-role': 'children' })
    list.replaceChildren(...buildChildrenList(s))
    return el('div', { class: 'sr-panel', 'data-panel': 'activity' }, el('div', { class: 'sr-title' }, '最近子代理'), list)
  }

  function buildBody(s: State = state!): HTMLElement {
    previewChannel = normalizePreviewChannel(s, previewChannel)
    const header = buildHeader(s)
    const summary = buildSummary(s)
    const offHint = undefined
    const tabs = buildTabs()
    const panels = el('div', { class: 'sr-panels', id: 'sr-panels' })
    const sessionPanel = buildSessionPanel(s)
    sessionPanel.setAttribute('role', 'tabpanel')
    sessionPanel.id = 'sr-panel-session'
    sessionPanel.setAttribute('aria-labelledby', 'sr-tab-session')
    if (selectedTab !== 'session') (sessionPanel as HTMLElement).hidden = true
    const globalPanel = buildGlobalPanel(s)
    globalPanel.setAttribute('role', 'tabpanel')
    globalPanel.id = 'sr-panel-global'
    globalPanel.setAttribute('aria-labelledby', 'sr-tab-global')
    if (selectedTab !== 'global') (globalPanel as HTMLElement).hidden = true
    const channelPanel = buildChannelPanel(s)
    channelPanel.setAttribute('role', 'tabpanel')
    channelPanel.id = 'sr-panel-channel'
    channelPanel.setAttribute('aria-labelledby', 'sr-tab-channel')
    if (selectedTab !== 'channel') (channelPanel as HTMLElement).hidden = true
    const activityPanel = buildActivityPanel(s)
    activityPanel.setAttribute('role', 'tabpanel')
    activityPanel.id = 'sr-panel-activity'
    activityPanel.setAttribute('aria-labelledby', 'sr-tab-activity')
    if (selectedTab !== 'activity') (activityPanel as HTMLElement).hidden = true
    panels.append(sessionPanel, globalPanel, channelPanel, activityPanel)
    const body = el('div', {}, header, offHint, summary, tabs, panels)
    return body
  }

  // ── 挂载与生命周期 ──
  root.addEventListener('mouseenter', () => { hoverPaused = true })
  root.addEventListener('mouseleave', () => { hoverPaused = false })

  const tryPlace = (): void => {
    const host = sidebarRoot()
    if (host === undefined) return
    if (root.parentElement === host && host.isConnected) return
    host.appendChild(root)
    // Observe host + body for self-heal. Remove redundant documentElement subtree observe — body subtree already covers lifecycle.
    rootObserver?.disconnect()
    rootObserver = new MutationObserver(() => {
      if (!root.isConnected) {
        rootObserver?.disconnect()
        rootObserver = undefined
        tryPlace()
        return
      }
      // Re-resolve host inside callback to avoid stale closure when framework replaces sidebar
      const currentHost = sidebarRoot()
      if (currentHost && root.parentElement !== currentHost && !currentHost.contains(root)) {
        tryPlace()
      } else if (!currentHost) {
        // no sidebar found — will be retried via waitObserver; keep root where it is
      }
    })
    rootObserver.observe(host, { childList: true })
    rootObserver.observe(document.body, { childList: true, subtree: true })
  }

  return {
    start() {
      // 初始占位（若尚未挂载，先放 body 底部避免空白）
      if (!root.isConnected) document.body.appendChild(root)
      tryPlace()
      waitObserver = new MutationObserver(() => tryPlace())
      waitObserver.observe(document.body, { childList: true, subtree: true })
      timer = window.setInterval(() => void tick(), 3000)
      void tick()
    },
    dispose() {
      disposed = true
      window.clearInterval(timer)
      waitObserver?.disconnect()
      waitObserver = undefined
      rootObserver?.disconnect()
      rootObserver = undefined
      window.removeEventListener(CURRENT_SESSION_EVENT, onCurrentSession)
      root.remove()
    },
  }
}
