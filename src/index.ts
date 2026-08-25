/**
 * @dsh-external/dsh-subagent-routing-console — host half.
 *
 * 子代理路由台：为所有委派通道（subagent 工具 / fork / workflow worker / ralph 等
 * 一切经过本进程 LLM 运行时的子会话）提供「模型 + 思考强度」的路由覆盖。
 *
 * 生效机制（经运行时验证的公开缝）：
 * 1. 子代理追踪：监听 dsh-subagent 的 'subagent/start' | 'subagent/end' 事件，
 *    维护 childSessionId → {channel(=subagent provider 注册名), 启动时间} 的活动表。
 * 2. 配置替换：挂 dsh-agent 的 'agent/request' 瀑布——每步构建请求时先 await next()
 *    取得机器将用的 LlmCallConfig，若该 agent 命中活动子代理表则返回替换后的
 *    {provider, model, reasoningEffort}。这是宿主文档明示的切换通道（"return a
 *    replacement to switch"），替换会被 request/header 变更记录持久留痕。
 *    思考强度先经 resolveModelInfo 校验目标模型支持，不支持则忽略并记录。
 *    （注：llm/stream 瀑布的请求对象已深冻结且尾部闭包按原引用分发，不可用。）
 *
 * 面板数据面：GET /subagent-router/state（策略+模型目录+活动子代理+改写统计），
 * PUT /subagent-router/policy（整份策略写回，JSON 持久化到 ~/.dsh/subagent-router/）。
 * 对话面：注册 subagent_route 工具，供会话中直接查询/切换路由策略。
 */
import type { Context } from 'cordis'
import type LlmService from '@deepseek-ai/dsh-llm'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { JsonValue } from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import z from 'schemastery'

type AppContext = Context & {
  llm: LlmService
  webServer: WebServerService
  systemPrompt: SystemPromptService
  tools: ToolsService
  sessions: SessionsService
}

/** 最小结构类型（避免为服务声明引入额外 peer 依赖）。 */
interface WebServerService {
  register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: any, res: any) => void | Promise<void> }): () => void
}
interface SystemPromptService {
  section(section: { name: string; order: number; text: string }): () => void
}
interface ToolsService {
  register(definition: ToolDefinition): () => void
}
interface SessionsService {
  list(): any[]
}

// ──────────────────────────────── 策略模型 ────────────────────────────────

/** 一条覆盖：缺省/空串字段 = 保持继承。 */
export interface OverrideSpec {
  provider?: string
  model?: string
  /** 目标模型的思考强度 id（如 low/medium/high/xhigh/max；'' = 模型默认）。 */
  effort?: string
}

export interface ChannelRule {
  /** subagent provider 注册名（spawn/fork/…）或 '*' 兜底。 */
  channel: string
  override: OverrideSpec
}

export interface Policy {
  version: 1
  /**
   * Compatibility field retained for persisted policy shape. The router is
   * always enabled and owns every delegated child request.
   */
  enabled: boolean
  /** 全局默认覆盖（所有子代理通道）。 */
  defaultOverride: OverrideSpec
  /** 会话级覆盖：key = 发起的顶层会话 id（用户可见的主会话），只对该会话派生的子代理生效。 */
  sessionOverrides: Record<string, OverrideSpec>
  /** 按通道规则：'*' 为兜底，精确 channel 覆盖同名字段。 */
  rules: ChannelRule[]
  presets: Record<string, { label: string; override: OverrideSpec }>
}

const DEFAULT_PRESETS: Policy['presets'] = {
  effort_low: { label: '🪫 低强度', override: { effort: 'low' } },
  effort_high: { label: '⚖️ 高强度', override: { effort: 'high' } },
  effort_max: { label: '🧠 拉满', override: { effort: 'max' } },
}

function defaultPolicy(): Policy {
  return {
    version: 1,
    enabled: true,
    // 全新部署的默认策略：跟随父级（不强制改写）。显式配置后由 policy.json 接管。
    defaultOverride: {},
    sessionOverrides: {},
    rules: [],
    presets: DEFAULT_PRESETS,
  }
}

/** 只保留白名单字段、全部收敛为 string | undefined，防面板/工具写入脏数据。 */
function sanitizeOverride(raw: unknown): OverrideSpec {
  const out: OverrideSpec = {}
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>
    if (typeof r.provider === 'string' && r.provider.trim()) out.provider = r.provider.trim()
    if (typeof r.model === 'string' && r.model.trim()) out.model = r.model.trim()
    if (typeof r.effort === 'string') out.effort = r.effort.trim()
  }
  return out
}

function sanitizePolicy(raw: unknown): Policy {
  const base = defaultPolicy()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const loadedDefault = sanitizeOverride(r.defaultOverride)
  // 不完整 pair（只有 provider 或只有 model）视为无效配置：丢弃路由部分，仅保留 effort。
  const defaultOverride = loadedDefault.provider && loadedDefault.model
    ? loadedDefault
    : { effort: loadedDefault.effort }
  const policy: Policy = {
    version: 1,
    // The router owns routing; an empty defaultOverride means "follow the parent".
    enabled: true,
    defaultOverride,
    sessionOverrides: {},
    rules: [],
    presets: base.presets,
  }
  if (r.sessionOverrides && typeof r.sessionOverrides === 'object') {
    for (const [sessionId, ov] of Object.entries(r.sessionOverrides as Record<string, unknown>)) {
      if (!sessionId.trim()) continue
      const cleaned = sanitizeOverride(ov)
      if (!isEmptyOverride(cleaned)) policy.sessionOverrides[sessionId.trim()] = cleaned
    }
  }
  if (Array.isArray(r.rules)) {
    for (const item of r.rules) {
      if (!item || typeof item !== 'object') continue
      const rule = item as Record<string, unknown>
      if (typeof rule.channel !== 'string' || !rule.channel.trim()) continue
      policy.rules.push({ channel: rule.channel.trim(), override: sanitizeOverride(rule.override) })
    }
  }
  return policy
}

function isEmptyOverride(o: OverrideSpec): boolean {
  return !o.provider && !o.model && !o.effort
}

// ──────────────────────────────── 活动子代理追踪 ────────────────────────────────

interface ChildRecord {
  runId: string
  channel: string
  /** 已解析的用户可见顶层会话；子会话释放后仍可用于面板归属。 */
  rootSessionId?: string
  startedAt: number
  endedAt?: number
  stopReason?: string
  /** 最近一次由本插件同步进系统提示词的身份变量。 */
  lastPromptIdentity?: { provider: string; model: string; at: number }
  /** 最近一次实际请求路由及本插件是否改写过它。 */
  lastRoute?: { provider: string; model: string; effort?: string; rewritten: boolean; at: number }
  /** 最近一次忽略覆盖的原因（如强度不被目标模型支持）。 */
  note?: string
}

const MAX_TRACKED_CHILDREN = 200

// ──────────────────────────────── 提示词通告 ────────────────────────────────

const SECTION_ORDER = 216
const ROUTER_GUIDANCE =
  '本机已安装子代理路由台插件（dsh-subagent-routing-console）：子代理模型与思考强度由路由台统一托管。左侧栏修改配置后必须点击「保存路由」；保存成功后写入策略文件并立即影响后续委派，无需重启。全局默认必须包含完整 provider + model；会话/通道覆盖只能在路由台全局默认之上继承。host 经 /subagent-router/* 路由提供策略读写与活动子代理监视。对话内可用 subagent_route 工具查询或修改路由策略：action=show 查看 / action=set 设置（scope=session 默认仅当前会话，scope=global 全局；provider+model 成对、effort 可选）/ action=preset 应用预设 / action=inherit 仅清除本会话覆盖；路由台不可关闭。用户提到「子代理模型 / 子代理思考强度 / 路由台」时即指本插件，请据此协作。'

// ──────────────────────────────── 插件本体 ────────────────────────────────

export const name = '@dsh-external/dsh-subagent-routing-console'
export const inject = ['llm', 'webServer', 'tools', 'systemPrompt', 'sessions']

export interface Config {
  enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx: AppContext, config: Config): void {
  const SHORT = 'dsh-subagent-routing-console'
  const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
  const policyFile = join(dshHome, SHORT, 'policy.json')

  // ── 策略存储：文件持久化，进程内单份 ──
  let policy: Policy = (() => {
    try {
      return sanitizePolicy(JSON.parse(readFileSync(policyFile, 'utf8')))
    } catch {
      return defaultPolicy()
    }
  })()
  let rewrites = 0

  const savePolicy = (): boolean => {
    try {
      mkdirSync(dirname(policyFile), { recursive: true })
      writeFileSync(policyFile, JSON.stringify(policy, null, 2), 'utf8')
      return true
    } catch (e) {
      ctx.logger?.warn?.('[' + SHORT + '] policy persist failed: ' + String(e))
      return false
    }
  }

  // ── 子代理活动表 ──
  const children = new Map<string, ChildRecord>()
  const trackChild = (info: { runId?: unknown; id?: unknown; provider?: unknown }, ended = false): void => {
    if (!info || typeof info.id !== 'string') return
    const prev = children.get(info.id)
    const record: ChildRecord = prev ?? {
      runId: typeof info.runId === 'string' ? info.runId : '',
      channel: typeof info.provider === 'string' ? info.provider : 'unknown',
      startedAt: Date.now(),
    }
    if (!prev && children.size >= MAX_TRACKED_CHILDREN) {
      // 淘汰最老的已结束条目；没有就淘汰最老条目。
      let oldestKey: string | undefined
      let oldestAt = Infinity
      for (const [key, value] of children) {
        const at = value.endedAt ?? value.startedAt
        if (at < oldestAt) {
          oldestAt = at
          oldestKey = key
        }
      }
      if (oldestKey !== undefined) children.delete(oldestKey)
    }
    if (ended) {
      record.endedAt = Date.now()
      record.stopReason = typeof (info as any).stopReason === 'string' ? (info as any).stopReason : undefined
    }
    children.set(info.id, record)
  }

  // dsh-subagent 事件未进本包类型程序，走 any 化注册（运行时事件名以宿主为准）。
  // ⚠️ ctx.on 返回 disposer：热重载时若不清理，旧 fiber 的监听器带着旧 policy 闭包
  // 继续截获 agent/request，导致新策略不生效（本会话踩过）。全部收集进 disposeEvents。
  const disposeEvents: Array<() => void> = []
  disposeEvents.push((ctx.on as any)('subagent/start', (info: any) => trackChild(info)))
  disposeEvents.push((ctx.on as any)('subagent/end', (info: any) => trackChild(info, true)))

  // ── 会话表：维护 live 会话的 lineage 与最近标题 ──
  // 用途：① 会话级覆盖归属（子代理 → 顶层祖先会话）；② 面板枚举可配置的顶层会话。
  // 标题以 session/title 事件为源；displayTitle 只作旧会话/无事件时的 fallback。
  interface SessionMeta {
    id: string
    origin?: string
    parentSession?: string
    displayTitle?: string
    createdAt: number
  }
  const sessionById = new Map<string, SessionMeta>()
  const titleFromSession = (session: any): string | undefined => {
    const events = Array.isArray(session?.events) ? session.events : []
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]
      if (event?.type !== 'session/title') continue
      const title = typeof event?.data?.title === 'string' ? event.data.title.trim() : ''
      if (title) return title
    }
    const displayTitle = typeof session?.displayTitle === 'string' ? session.displayTitle.trim() : ''
    return displayTitle || undefined
  }
  const rememberSession = (session: any): void => {
    const id = typeof session?.id === 'string' ? session.id : ''
    if (!id) return
    const header = session?.header ?? {}
    const previous = sessionById.get(id)
    sessionById.set(id, {
      id,
      origin: typeof header.origin === 'string' ? header.origin : undefined,
      parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
      displayTitle: titleFromSession(session) ?? previous?.displayTitle,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : previous?.createdAt ?? Date.now(),
    })
  }
  for (const session of ctx.sessions.list()) rememberSession(session)
  disposeEvents.push((ctx.on as any)('session/created', (session: any) => rememberSession(session)))
  disposeEvents.push((ctx.on as any)('session/event', (session: any, event: any) => {
    if (event?.type !== 'session/title') return
    const id = typeof session?.id === 'string' ? session.id : ''
    if (!id) return
    const title = typeof event?.data?.title === 'string' ? event.data.title.trim() : ''
    if (!title) return
    const existing = sessionById.get(id)
    if (existing) existing.displayTitle = title
    else rememberSession(session)
  }))
  disposeEvents.push((ctx.on as any)('session/disposed', (session: any) => {
    const id = typeof session?.id === 'string' ? session.id : ''
    if (id) sessionById.delete(id)
  }))

  // ── effort 支持表：provider\x00model → 支持的强度 id 列表（[] = 无强度概念）──
  const effortsCache = new Map<string, readonly string[] | undefined>()
  async function effortsFor(provider: string, model: string): Promise<readonly string[] | undefined> {
    const key = provider + '\u0000' + model
    if (effortsCache.has(key)) return effortsCache.get(key)
    try {
      const info = await ctx.llm.resolveModelInfo(provider, model)
      const ids = (info.reasoning?.efforts ?? []).map((e) => String(e.id))
      effortsCache.set(key, ids)
      return ids
    } catch {
      effortsCache.set(key, undefined)
      return undefined
    }
  }

  // ── 覆盖解析：全局 → '*' 兜底 → 精确通道 → 顶层会话，按字段继承 ──
  // provider/model 是不可拆分的路由身份；只有同一层给出完整对时才能替换身份。
  // effort 可单独继承，但不会凭空构造提示词身份。
  function effectiveOverride(channel: string, topAncestor: string | undefined): OverrideSpec {
    // The managed baseline makes parent agent options irrelevant even if an old
    // policy file or a stale listener asks for an empty override.

    const merged: OverrideSpec = {}
    const applyLayer = (layer: OverrideSpec | undefined): void => {
      if (!layer) return
      if (layer.provider && layer.model) {
        merged.provider = layer.provider
        merged.model = layer.model
      }
      if (layer.effort) merged.effort = layer.effort
    }

    applyLayer(policy.defaultOverride)
    const fallback = policy.rules.find((rule) => rule.channel === '*' && !isEmptyOverride(rule.override))
    applyLayer(fallback?.override)
    const exact = channel === '*'
      ? undefined
      : policy.rules.find((rule) => rule.channel === channel && !isEmptyOverride(rule.override))
    applyLayer(exact?.override)
    if (topAncestor) applyLayer(policy.sessionOverrides[topAncestor])

    // 空覆盖 = 跟随父级：交回空对象，由 agent/request 钩子的守卫原样放行。
    return merged
  }

  /**
   * 求一个子代理会话的「顶层祖先会话 id」——沿 session header 的 parentSession 向上
   * 追溯，直到没有父（或父不再标记为 subagent origin），即用户可见的发起会话。
   * 优先用 agent 自带的 session.header（瀑布在手的权威来源），事件表仅兜底。
   */
  function topAncestorOf(sessionId: string, liveSession?: any): string | undefined {
    let cur: string | undefined = sessionId
    const seen = new Set<string>()
    for (let i = 0; i < 32 && cur; i++) {
      if (seen.has(cur)) return undefined
      seen.add(cur)
      let meta: Pick<SessionMeta, 'id' | 'origin' | 'parentSession'> | undefined
      if (i === 0 && liveSession) {
        const header = liveSession.header ?? {}
        meta = {
          id: cur,
          origin: typeof header.origin === 'string' ? header.origin : undefined,
          parentSession: typeof header.parentSession === 'string' ? header.parentSession : undefined,
        }
      } else {
        meta = sessionById.get(cur)
      }
      if (!meta) return cur
      if (meta.origin !== 'subagent' || !meta.parentSession) return cur
      cur = meta.parentSession
    }
    return cur
  }

  // ── 提示词路由同步：assemble 早于 agent/request，故在渲染前同步身份变量 ──
  // prepend 使本监听器包住 scoped model selection；await next() 后再覆盖，避免其将
  // provider/model 写回父级。仅完整的 provider/model 覆盖可以声明一个新路由。
  disposeEvents.push((ctx.on as any)('system-prompt/assemble', async (
    _assembly: { variables: Record<string, string | undefined> },
    promptContext: { agent?: { id?: unknown; session?: unknown } },
    next: () => Promise<{ variables: Record<string, string | undefined> }>,
  ) => {
    const assembled = await next()
    try {
      const agent = promptContext?.agent
      const sid = typeof agent?.id === 'string' ? agent.id : ''
      const child = sid ? children.get(sid) : undefined
      if (!child) return assembled
      const topAncestor = topAncestorOf(sid, agent?.session)
      if (topAncestor) child.rootSessionId = topAncestor
      const ov = effectiveOverride(child.channel, topAncestor)
      if (!ov?.provider || !ov.model) return assembled
      child.lastPromptIdentity = { provider: ov.provider, model: ov.model, at: Date.now() }
      return {
        ...assembled,
        variables: {
          ...assembled.variables,
          provider: ov.provider,
          model: ov.model,
        },
      }
    } catch (e) {
      // Prompt identity is advisory; a synchronization fault must not block the child.
      ctx.logger?.warn?.('[' + SHORT + '] system-prompt route hook failed: ' + String(e))
      return assembled
    }
  }, { prepend: true, global: true }))

  // ── 核心钩子：agent/request 瀑布替换调用配置 ──
  // Global: every delegated request passes through the router; empty override =
  // follow the parent (pass-through), and router faults also pass through (fail-open).
  disposeEvents.push((ctx.on as any)('agent/request', async (payload: any, next: () => Promise<any>) => {
    const config = await next()
    const agent = payload?.agent
    const sid = typeof agent?.id === 'string' ? agent.id : ''
    const liveSession = agent?.session
    const child = sid ? children.get(sid) : undefined
    const header = liveSession?.header ?? {}
    const depth = agent?.options?.subagentDepth ?? header.delegationDepth
    const delegated = Boolean(child)
      || header.origin === 'subagent'
      || (Number.isSafeInteger(depth) && depth > 0)
    if (!delegated) return config

    const channel = child?.channel ?? 'spawn'
    const topAncestor = sid ? topAncestorOf(sid, liveSession) : undefined
    if (child && topAncestor) child.rootSessionId = topAncestor
    const ov = effectiveOverride(channel, topAncestor)
    // 跟随父级：无完整路由覆盖时原样放行（v0.0.2 起，无策略部署不再强制改写）。
    if (!ov?.provider || !ov.model) {
      if (ov?.effort) {
        // 仅强度覆盖：保留父级 provider/model，只改思考强度。
        try {
          const allowed = await effortsFor(config.provider, config.model)
          if (!allowed || allowed.includes(ov.effort)) {
            rewrites += 1
            return { ...config, reasoningEffort: ReasoningEffortId(ov.effort) }
          }
          ctx.logger?.warn?.('[' + SHORT + '] effort "' + ov.effort + '" 不被 ' + String(config.provider) + '/' + String(config.model) + ' 支持，已忽略')
        } catch (e) {
          ctx.logger?.warn?.('[' + SHORT + '] effort-only route failed; passing parent config: ' + String(e))
        }
      }
      return config
    }
    try {
      let patched = { ...config, provider: ov.provider, model: ov.model }
      let rewritten = ov.provider !== config.provider || ov.model !== config.model
      let note: string | undefined
      if (ov.effort) {
        const allowed = await effortsFor(patched.provider, patched.model)
        // Unknown catalogs are allowed; known catalogs reject unsupported effort.
        if (allowed && !allowed.includes(ov.effort)) {
          note = 'effort "' + ov.effort + '" 不被 ' + patched.provider + '/' + patched.model + ' 支持，已忽略'
          ctx.logger?.warn?.('[' + SHORT + '] child ' + String(sid).slice(0, 8) + ': ' + note)
        } else {
          patched = { ...patched, reasoningEffort: ReasoningEffortId(ov.effort) }
          rewritten = true
        }
      }
      if (rewritten) rewrites += 1
      if (child) {
        child.lastRoute = {
          provider: patched.provider,
          model: patched.model,
          effort: patched.reasoningEffort ? String(patched.reasoningEffort) : undefined,
          rewritten,
          at: Date.now(),
        }
        child.note = note
      }
      return patched
    } catch (e) {
      // Fail-open: on router fault, pass the parent-selected route through instead of
      // forcing a baseline that may not exist in this deployment (v0.0.2+).
      ctx.logger?.warn?.('[' + SHORT + '] agent/request hook failed; passing parent route through: ' + String(e))
      return config
    }
  }, { prepend: true, global: true }))

  // ── 模型目录（TTL 缓存）──
  interface CatalogModel {
    id: string
    name: string
    efforts: readonly string[]
    defaultEffort?: string
  }
  interface CatalogProvider {
    name: string
    models: CatalogModel[]
  }
  let catalogCache: CatalogProvider[] = []
  let catalogAt = 0
  async function catalog(): Promise<CatalogProvider[]> {
    if (catalogCache.length && Date.now() - catalogAt < 60_000) return catalogCache
    const providers = ctx.llm.listProviders()
    const out: CatalogProvider[] = []
    for (const p of providers) {
      const entry: CatalogProvider = { name: String((p as any).name ?? ''), models: [] }
      if (!entry.name) continue
      try {
        const models = await ctx.llm.listModels(entry.name)
        for (const m of models) {
          const model: CatalogModel = { id: String(m.id), name: String(m.name ?? m.id), efforts: [] }
          try {
            const resolved = await ctx.llm.resolveModelInfo(entry.name, model.id)
            model.efforts = (resolved.reasoning?.efforts ?? []).map((e) => String(e.id))
            if (resolved.reasoning?.defaultEffort) model.defaultEffort = String(resolved.reasoning.defaultEffort)
          } catch {
            /* 强度未知 → 空列表，面板显示「默认」*/
          }
          entry.models.push(model)
        }
      } catch {
        /* 目录失败 → 该 provider 空列表 */
      }
      out.push(entry)
    }
    catalogCache = out
    catalogAt = Date.now()
    return out
  }

  // ── HTTP 数据面 ──
  const json = (res: any, code: number, payload: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
  const readBody = (req: any): Promise<string> =>
    new Promise((resolve, reject) => {
      let data = ''
      req.on('data', (chunk: Buffer) => {
        data += chunk.toString('utf8')
        if (data.length > 256 * 1024) reject(new Error('payload too large'))
      })
      req.on('end', () => resolve(data))
      req.on('error', reject)
    })

  async function statePayload() {
    const list = [...children.entries()].map(([sessionId, c]) => ({ sessionId, ...c }))
    list.sort((a, b) => b.startedAt - a.startedAt)
    // 顶层会话枚举：会话表（session/created 捕获）+ children 派生（委派过的根会话）去重。
    const rootIds = new Map<string, string | undefined>()
    for (const c of list) {
      const root = c.rootSessionId ?? topAncestorOf(c.sessionId)
      if (root) rootIds.set(root, sessionById.get(root)?.displayTitle)
    }
    for (const s of sessionById.values()) {
      if (s.origin !== 'subagent') rootIds.set(s.id, s.displayTitle)
    }
    const topSessions = [...rootIds.entries()].map(([id, title]) => ({ id, title }))
    return {
      ok: true,
      policy,
      catalog: await catalog(),
      channels: [...new Set(['spawn', 'fork', ...list.map((c) => c.channel)])],
      children: list.slice(0, 50),
      topSessions,
      stats: { rewrites, trackedActive: list.filter((c) => !c.endedAt).length },
    }
  }

  const disposeRoutes: Array<() => void> = []
  disposeRoutes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/subagent-router/state',
      handler: async (_req, res) => {
        try {
          json(res, 200, await statePayload())
        } catch (e) {
          json(res, 500, { ok: false, error: String(e) })
        }
      },
    }),
  )
  disposeRoutes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/subagent-router/policy',
      handler: async (req, res) => {
        if (req.method !== 'PUT' && req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
          if (body.enabled === false) throw new Error('子代理路由台始终处于托管模式，不能关闭。')
          const requestedDefault = sanitizeOverride(body.defaultOverride)
          if (!requestedDefault.provider || !requestedDefault.model) {
            throw new Error('必须保存完整的全局 provider + model 路由。')
          }
          const previous = policy
          const candidate = sanitizePolicy({ ...policy, ...body, version: 1 as const, presets: policy.presets })
          policy = candidate
          if (!savePolicy()) {
            policy = previous
            throw new Error('路由策略写盘失败，当前运行策略未改变。')
          }
          // 预热 effort 支持表，避免首笔委派在瀑布里同步等目录。
          const targets: Array<[string, string]> = []
          const collect = (o: OverrideSpec): void => {
            if (o.provider && o.model && o.effort) targets.push([o.provider, o.model])
          }
          collect(policy.defaultOverride)
          for (const rule of policy.rules) collect(rule.override)
          await Promise.all(targets.map(([p, m]) => effortsFor(p, m)))
          json(res, 200, await statePayload())
        } catch (e) {
          json(res, 400, { ok: false, error: String(e) })
        }
      },
    }),
  )

  // ── 当前会话路由：供聊天输入栏直接保存会话覆盖 ──
  disposeRoutes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/subagent-router/session',
      handler: async (req, res) => {
        if (req.method !== 'PUT' && req.method !== 'POST') {
          json(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        try {
          const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>
          const requestedSessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
          if (!requestedSessionId) throw new Error('缺少当前会话 ID。')
          // UI normally supplies a top-level session. Normalize a child ID too, so
          // a copied/session-addressed control cannot create an orphan override.
          const sessionId = topAncestorOf(requestedSessionId) ?? requestedSessionId
          const override = body.inherit === true || body.override === null
            ? {}
            : sanitizeOverride(body.override)
          const hasProvider = Boolean(override.provider)
          const hasModel = Boolean(override.model)
          if (hasProvider !== hasModel) {
            throw new Error('会话路由的 provider + model 必须成对保存。')
          }
          const previous = policy
          const next: Policy = {
            ...policy,
            enabled: true,
            defaultOverride: { ...policy.defaultOverride },
            sessionOverrides: Object.fromEntries(Object.entries(policy.sessionOverrides).map(([k, v]) => [k, { ...v }])),
            rules: policy.rules.map((r) => ({ channel: r.channel, override: { ...r.override } })),
          }
          if (isEmptyOverride(override)) delete next.sessionOverrides[sessionId]
          else next.sessionOverrides[sessionId] = override
          policy = next
          if (!savePolicy()) {
            policy = previous
            throw new Error('路由策略写盘失败，当前运行策略未改变。')
          }
          if (override.provider && override.model && override.effort) {
            await effortsFor(override.provider, override.model)
          }
          json(res, 200, { ...(await statePayload()), sessionId })
        } catch (e) {
          json(res, 400, { ok: false, error: String(e) })
        }
      },
    }),
  )

  // ── 对话内工具：subagent_route ──
  const routeTool = defineTool({
    name: 'subagent_route',
    description:
      '查看或修改子代理路由策略（所有委派子代理的模型与思考强度均由此统一管理）。action=show 查看；action=set 设置 provider+model（全局必须完整，session 可只改 effort）；action=preset 应用强度预设；action=inherit 清除当前会话覆盖。路由台始终托管，不能关闭。',
    parameters: {
      action: { type: 'string', enum: ['show', 'set', 'preset', 'inherit'], required: true, description: '操作类型：show 查看 / set 设置覆盖 / preset 应用强度预设 / inherit 清除本会话覆盖' },
      scope: { type: 'string', enum: ['global', 'session'], description: 'set/preset/inherit 的作用域（默认 session=仅当前会话，global=全局）' },
      provider: { type: 'string', description: '目标 provider 路由名（set 时与 model 成对）' },
      model: { type: 'string', description: '目标模型 id（set 时与 provider 成对）' },
      effort: { type: 'string', description: '思考强度 id（如 low/medium/high/xhigh/max，空串=模型默认）' },
      preset: { type: 'string', description: '预设名（preset 时必填）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async (args, exec): Promise<Record<string, JsonValue>> => {
      const a = args as Record<string, string>
      const ovJson = (o: OverrideSpec) => ({ provider: o.provider ?? '', model: o.model ?? '', effort: o.effort ?? '' })
      // 当前发起会话：工具在哪个 agent 的 turn 里被调用，exec.agent 就是它。
      const callerSession = typeof (exec as any).agent?.id === 'string' ? String((exec as any).agent.id) : ''
      const scope = a.scope === 'global' ? 'global' : 'session'
      const targetKey = scope === 'global' ? undefined : callerSession || undefined
      const writeOverride = (override: OverrideSpec): void => {
        const previous = policy
        const next: Policy = {
          ...policy,
          enabled: true,
          defaultOverride: { ...policy.defaultOverride },
          sessionOverrides: Object.fromEntries(Object.entries(policy.sessionOverrides).map(([k, v]) => [k, { ...v }])),
          rules: policy.rules.map((r) => ({ channel: r.channel, override: { ...r.override } })),
        }
        if (targetKey) {
          if (isEmptyOverride(override)) delete next.sessionOverrides[targetKey]
          else next.sessionOverrides[targetKey] = { ...override }
        } else {
          if (!override.provider || !override.model) throw new Error('全局路由必须包含完整 provider + model。')
          next.defaultOverride = { ...override }
        }
        policy = next
        if (!savePolicy()) {
          policy = previous
          throw new Error('路由策略写盘失败，当前运行策略未改变。')
        }
      }
      if (a.action === 'show') {
        const sessionOv = callerSession ? policy.sessionOverrides[callerSession] : undefined
        return {
          ok: true,
          enabled: policy.enabled,
          scope: callerSession ? 'session' : 'global',
          sessionId: callerSession || '',
          sessionOverride: sessionOv ? ovJson(sessionOv) : ovJson({}),
          defaultOverride: ovJson(policy.defaultOverride),
          rules: policy.rules.map((r) => ({ channel: r.channel, override: ovJson(r.override) })),
          activeChildren: [...children.values()].filter((c) => !c.endedAt).length,
          totalRewrites: rewrites,
        }
      }
      if (a.action === 'inherit') {
        if (scope === 'global') return { ok: false, error: '不能清除全局路由；请保存一个明确的 provider + model。' }
        if (!targetKey) return { ok: false, error: '当前调用没有可清除的会话覆盖。' }
        writeOverride({})
        return {
          ok: true,
          scope,
          message: '本会话覆盖已清除；该会话的子代理继续使用路由台全局默认。',
        }
      }
      if (a.action === 'preset') {
        const preset = policy.presets[a.preset ?? '']
        if (!preset) {
          return { ok: false, error: '未知预设: ' + String(a.preset), available: Object.keys(policy.presets) }
        }
        const current = targetKey ? { ...(policy.sessionOverrides[targetKey] ?? {}) } : { ...policy.defaultOverride }
        writeOverride({ ...current, ...sanitizeOverride(preset.override) })
        return targetKey
          ? { ok: true, enabled: true, scope, applied: preset.label, defaultOverride: ovJson(policy.defaultOverride), sessionOverride: ovJson(policy.sessionOverrides[targetKey] ?? {}) }
          : { ok: true, enabled: true, scope, applied: preset.label, defaultOverride: ovJson(policy.defaultOverride) }
      }
      // action === 'set'
      const hasPair = Boolean(a.provider && a.model)
      const hasEffort = typeof a.effort === 'string'
      if (!hasPair && !hasEffort) {
        return { ok: false, error: 'set 需要 provider+model 成对，或至少提供 effort' }
      }
      const current: OverrideSpec = targetKey ? { ...(policy.sessionOverrides[targetKey] ?? {}) } : { ...policy.defaultOverride }
      if (hasPair) {
        current.provider = a.provider
        current.model = a.model
      }
      if (hasEffort) current.effort = a.effort
      writeOverride(current)
      if (current.provider && current.model && current.effort) await effortsFor(current.provider, current.model)
      return targetKey
        ? { ok: true, enabled: true, scope, defaultOverride: ovJson(policy.defaultOverride), sessionOverride: ovJson(policy.sessionOverrides[targetKey] ?? {}) }
        : { ok: true, enabled: true, scope, defaultOverride: ovJson(policy.defaultOverride) }
    },
  })
  const disposeTool = ctx.tools.register(routeTool)

  // ── 提示词通告 ──
  let disposeSection: (() => void) | undefined
  const syncSection = (): void => {
    disposeSection?.()
    disposeSection = undefined
    disposeSection = ctx.systemPrompt.section({ name: 'plugin:subagent-router', order: SECTION_ORDER, text: ROUTER_GUIDANCE })
  }
  syncSection()

  ctx.logger?.info?.('[' + SHORT + '] 路由台就绪（enabled=' + policy.enabled + '，规则 ' + policy.rules.length + ' 条）')

  ctx.effect(() => () => {
    disposeSection?.()
    disposeTool()
    for (const d of disposeRoutes) d()
    for (const d of disposeEvents) d?.()
  })
}
