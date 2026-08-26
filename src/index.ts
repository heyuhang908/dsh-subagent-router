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
 * 面板数据面：GET /subagent-routing-console/state（策略+模型目录+活动子代理+改写统计），
 * PUT /subagent-routing-console/policy（整份策略写回，JSON 持久化到 ~/.dsh/subagent-routing-console/）。
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

export interface AutoRule {
  /** 关键词列表（不区分大小写，子串匹配子代理任务文本）。 */
  keywords: string[]
  /** 命中后应用的预设名（policy.presets 的键，如 role_scout）。 */
  preset: string
  /** 可选：仅对指定通道生效（如 fork/workflow）；留空 = 全通道。 */
  channels?: string[]
  enabled: boolean
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
  /**
   * 关键词自动路由：任务文本命中关键词时应用对应预设的路由。
   * 优先级最低（在全局默认之后、通道/会话覆盖之前生效），可被上层覆盖。
   */
  autoRules?: AutoRule[]
}

const DEFAULT_PRESETS: Policy['presets'] = {
  effort_low: { label: '🪫 低强度', override: { effort: 'low' } },
  effort_high: { label: '⚖️ 高强度', override: { effort: 'high' } },
  effort_max: { label: '🧠 拉满', override: { effort: 'max' } },
}

/**
 * 角色预设：模型 + 思考强度的组合档案（借鉴角色路由类插件）。
 * provider/model 留空 = 只覆盖强度，模型跟随父级/全局默认；填了即为完整路由覆盖。
 * 首次使用时用户可在面板或 policy.json 中把角色绑定到具体模型。
 */
const ROLE_PRESET_HINTS: Array<{ key: string; label: string; override: OverrideSpec; hint: string }> = [
  { key: 'role_scout', label: '🔍 侦察', override: { effort: 'low' }, hint: '探索/检索类子代理：低强度省钱' },
  { key: 'role_reviewer', label: '🧐 评审', override: { effort: 'high' }, hint: '评审/审查类子代理：高强度把关' },
  { key: 'role_architect', label: '🏗️ 架构', override: { effort: 'max' }, hint: '架构/规划类子代理：拉满思考' },
]

/**
 * 关键词自动路由默认规则：任务文本命中即应用对应角色路由（宿主强制，模型无感）。
 * 匹配子代理首条 user 消息（含 description/prompt），不区分大小写子串匹配。
 * 用户可在 policy.json 的 autoRules 中增删改；enabled=false 或删空数组即停用。
 */
const DEFAULT_AUTO_RULES: AutoRule[] = [
  {
    keywords: ['调研', '检索', '查找', '搜索', '调研一下', '探索', '排查', '定位', '找出', '列出', '盘点', 'search', 'find', 'explore', 'investigate', 'locate', 'scan'],
    preset: 'role_scout',
    enabled: true,
  },
  {
    keywords: ['审查', '评审', 'review', '审计', '把关', '挑错', '找茬', '验证', '校验', '检查', 'verify', 'audit'],
    preset: 'role_reviewer',
    enabled: true,
  },
  {
    keywords: ['架构', '设计', '规划', '方案', '重构计划', '蓝图', '总体', '选型', 'architect', 'design', 'plan', 'blueprint'],
    preset: 'role_architect',
    enabled: true,
  },
]

function defaultPolicy(): Policy {
  return {
    version: 1,
    enabled: true,
    // 全新部署的默认策略：跟随父级（不强制改写）。显式配置后由 policy.json 接管。
    defaultOverride: {},
    sessionOverrides: {},
    rules: [],
    presets: {
      ...DEFAULT_PRESETS,
      ...Object.fromEntries(ROLE_PRESET_HINTS.map((r) => [r.key, { label: r.label, override: r.override }])),
    },
    autoRules: DEFAULT_AUTO_RULES.map((r) => ({ ...r, keywords: [...r.keywords] })),
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

/** 危险键黑名单：防手写 policy.json 注入 __proto__/constructor/prototype 造成原型污染。 */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
function isSafeKey(key: string): boolean {
  return key.length <= 200 && !DANGEROUS_KEYS.has(key)
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
    // 预设合并：代码默认打底，用户自定义（policy.json）覆盖/新增——否则自定义角色绑定会被加载时重置。
    presets: mergePresets(base.presets, r.presets),
  }
  if (r.sessionOverrides && typeof r.sessionOverrides === 'object') {
    for (const [sessionId, ov] of Object.entries(r.sessionOverrides as Record<string, unknown>)) {
      if (!sessionId.trim() || !isSafeKey(sessionId.trim())) continue
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
  if (Array.isArray(r.autoRules)) {
    const autoRules: AutoRule[] = []
    for (const item of r.autoRules) {
      if (!item || typeof item !== 'object') continue
      const raw = item as Record<string, unknown>
      if (typeof raw.preset !== 'string' || !raw.preset.trim() || !isSafeKey(raw.preset.trim())) continue
      const keywords = Array.isArray(raw.keywords)
        ? raw.keywords.filter((k): k is string => typeof k === 'string' && k.trim().length > 0 && k.trim().length <= 100).map((k) => k.trim())
        : []
      if (!keywords.length) continue
      autoRules.push({
        keywords: keywords.slice(0, 50),
        preset: raw.preset.trim(),
        ...(Array.isArray(raw.channels) ? { channels: raw.channels.filter((c): c is string => typeof c === 'string' && c.trim().length > 0).map((c) => c.trim()).slice(0, 20) } : {}),
        enabled: raw.enabled !== false,
      })
    }
    // 用户显式提供 autoRules（含空数组=明确停用）时以用户为准；缺失（旧版 policy.json）时回落代码默认。
    policy.autoRules = autoRules
  } else {
    policy.autoRules = base.autoRules
  }
  return policy
}

function isEmptyOverride(o: OverrideSpec): boolean {
  return !o.provider && !o.model && !o.effort
}

/** 预设合并：默认打底，用户定义覆盖同名/追加新键；条目结构不合法时跳过该条。 */
function mergePresets(defaults: Policy['presets'], raw: unknown): Policy['presets'] {
  const out: Policy['presets'] = { ...defaults }
  if (!raw || typeof raw !== 'object') return out
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim() || !isSafeKey(key.trim()) || !value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (typeof v.label !== 'string' || !v.label.trim()) continue
    const override = sanitizeOverride(v.override)
    if (isEmptyOverride(override)) continue
    out[key.trim()] = { label: v.label.trim(), override }
  }
  return out
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

  // ── 覆盖解析：全局 → 关键词自动规则 → '*' 兜底 → 精确通道 → 顶层会话，按字段继承 ──
  // provider/model 是不可拆分的路由身份；只有同一层给出完整对时才能替换身份。
  // effort 可单独继承，但不会凭空构造提示词身份。

  /**
   * 提取子代理的任务文本（用于关键词匹配）：子代理会话日志的首条 user/message。
   * 数据源优先级：live session.events（权威）→ sessionById 无文本，故仅 live 可用。
   * 取不到时返回空串（自动规则静默跳过，不影响原路由）。
   */
  /** 最近一次 taskTextOf 诊断（保留：state.autoRouteDebug 供面板/排查用，无敏感内容——只含事件类型与长度）。 */
  let lastTaskTextDebug: Record<string, string> = {}
  function taskTextOf(sid: string, liveSession: any): string {
    try {
      const events = Array.isArray(liveSession?.events) ? liveSession.events : []
      if (!events.length) {
        lastTaskTextDebug = { sid: String(sid).slice(0, 8), result: 'events 为空/缺失', hasLive: liveSession ? '1' : '0' }
        return ''
      }
      const types = events.slice(0, 15).map((e: any) => String(e?.type ?? '?'))
      for (const event of events) {
        if (event?.type !== 'user/message') continue
        const blocks = Array.isArray(event?.data?.content) ? event.data.content : []
        const text = blocks.filter((b: any) => b?.type === 'text').map((b: any) => String(b?.text ?? '')).join('\n')
        if (text.trim()) {
          lastTaskTextDebug = { sid: String(sid).slice(0, 8), result: '命中', types: types.join(','), len: String(text.length) }
          return text.slice(0, 4000)
        }
      }
      lastTaskTextDebug = { sid: String(sid).slice(0, 8), result: '无可用 user/message', types: types.join(',') }
    } catch (e) {
      lastTaskTextDebug = { sid: String(sid).slice(0, 8), result: '异常: ' + String(e).slice(0, 120) }
    }
    return ''
  }

  /** 关键词自动路由：返回首个命中规则（enabled 且通道匹配且文本含任一关键词）的预设覆盖及来源标注。 */
  function autoRuleOverride(taskText: string, channel: string): { override: OverrideSpec; via: string } | undefined {
    const autoRules = policy.autoRules
    if (!taskText || !Array.isArray(autoRules) || !autoRules.length) return undefined
    const text = taskText.toLowerCase()
    for (const rule of autoRules) {
      if (!rule?.enabled) continue
      if (rule.channels?.length && !rule.channels.includes(channel)) continue
      if (!rule.preset) continue
      const hitKeyword = rule.keywords.find((k) => text.includes(k.toLowerCase()))
      if (!hitKeyword) continue
      const preset = policy.presets[rule.preset]
      if (!preset || isEmptyOverride(preset.override)) continue
      return { override: preset.override, via: '自动规则[' + rule.preset + ']命中关键词「' + hitKeyword + '」' }
    }
    return undefined
  }

  function effectiveOverride(channel: string, topAncestor: string | undefined, taskText = ''): OverrideSpec {
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
    applyLayer(autoRuleOverride(taskText, channel)?.override)
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
    const taskText = taskTextOf(sid, liveSession)
    const autoHit = autoRuleOverride(taskText, channel)
    const ov = autoHit ? autoHit.override : effectiveOverride(channel, topAncestor, taskText)
    const viaNote = autoHit?.via
    // 跟随父级：无完整路由覆盖时原样放行（v0.0.2 起，无策略部署不再强制改写）。
    if (!ov?.provider || !ov.model) {
      if (ov?.effort) {
        // 仅强度覆盖：保留父级 provider/model，只改思考强度。
        try {
          const allowed = await effortsFor(config.provider, config.model)
          if (!allowed || allowed.includes(ov.effort)) {
            rewrites += 1
            if (child) {
              child.lastRoute = { provider: String(config.provider ?? ''), model: String(config.model ?? ''), effort: ov.effort, rewritten: true, at: Date.now() }
            }
            return { ...config, reasoningEffort: ReasoningEffortId(ov.effort) }
          }
          const note = 'effort "' + ov.effort + '" 不被 ' + String(config.provider) + '/' + String(config.model) + ' 支持，已忽略'
          if (child) child.note = note
          ctx.logger?.warn?.('[' + SHORT + '] ' + note)
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
        child.note = viaNote ?? note
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
      autoRouteDebug: lastTaskTextDebug,
    }
  }

  const disposeRoutes: Array<() => void> = []
  disposeRoutes.push(
    ctx.webServer.register({
      kind: 'exact',
      path: '/subagent-routing-console/state',
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
      path: '/subagent-routing-console/policy',
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
      path: '/subagent-routing-console/session',
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
      '查看或修改子代理路由策略（所有委派子代理的模型与思考强度均由此统一管理）。action=show 查看；action=set 设置 provider+model（全局必须完整，session 可只改 effort）；action=preset 应用强度/角色预设（preset 留空=列出全部可用预设）；action=inherit 清除当前会话覆盖。路由台始终托管，不能关闭。注意：可续接子代理（fork/后台续聊）每次续聊都重新过路由——改路由后其下一轮即用新模型；一次性子代理路由在首请求定型。',
    parameters: {
      action: { type: 'string', enum: ['show', 'set', 'preset', 'inherit'], required: true, description: '操作类型：show 查看 / set 设置覆盖 / preset 应用强度预设 / inherit 清除本会话覆盖' },
      scope: { type: 'string', enum: ['global', 'session'], description: 'set/preset/inherit 的作用域（默认 session=仅当前会话，global=全局）' },
      provider: { type: 'string', description: '目标 provider 路由名（set 时与 model 成对）' },
      model: { type: 'string', description: '目标模型 id（set 时与 provider 成对）' },
      effort: { type: 'string', description: '思考强度 id（如 low/medium/high/xhigh/max，空串=模型默认）' },
      preset: { type: 'string', description: '预设名（preset 时可选；留空=列出全部可用预设及角色提示）' },
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
        // 列出预设：action=preset 且未指定 preset 名时返回可用清单（含角色提示）。
        if (typeof a.preset !== 'string' || !a.preset.trim()) {
          return {
            ok: true,
            scope,
            presets: Object.fromEntries(Object.entries(policy.presets).map(([k, v]) => [k, { label: v.label, override: ovJson(v.override) }])),
            roleHints: Object.fromEntries(ROLE_PRESET_HINTS.map((r) => [r.key, r.hint])),
            hint: '用 action=preset + preset=<名称> 应用；角色预设可先在面板/policy.json 绑定具体模型。',
          }
        }
        const preset = policy.presets[a.preset]
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

  // ── 汇聚工具：等待后台子代理结算（借鉴 wait-for-subagents 模式） ──
  const waitTool = defineTool({
    name: 'subagent_wait',
    description:
      '等待委派出去的子代理结算并回收结果。适合「派发多个后台子代理 → 汇聚全部结果再汇总」的模式。可等待全部活动子代理或指定会话 id（支持逗号分隔多个），带超时保护；超时时返回已完成与仍在运行的部分。',
    parameters: {
      sessionIds: { type: 'string', description: '可选：要等待的子代理会话 id，逗号分隔多个；留空=等待当前所有活动子代理' },
      timeoutMs: { type: 'number', description: '最长等待毫秒数（默认 120000，上限 600000）' },
      pollMs: { type: 'number', description: '轮询间隔毫秒数（默认 500，下限 100）' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args) {
      const a = args as { sessionIds?: unknown; timeoutMs?: unknown; pollMs?: unknown }
      const timeoutMs = Math.min(600_000, Math.max(1_000, typeof a.timeoutMs === 'number' && Number.isFinite(a.timeoutMs) ? a.timeoutMs : 120_000))
      const pollMs = Math.max(100, typeof a.pollMs === 'number' && Number.isFinite(a.pollMs) ? a.pollMs : 500)
      const wanted = typeof a.sessionIds === 'string' && a.sessionIds.trim()
        ? a.sessionIds.split(',').map((s) => s.trim()).filter(Boolean)
        : []
      const deadline = Date.now() + timeoutMs
      // 目标匹配：Map 主键（=子代理会话 id，即委派工具返回的 id）、runId、rootSessionId 三者任一命中。
      const findTargets = (): Array<[string, ChildRecord]> => {
        const all = [...children.entries()]
        if (!wanted.length) return all
        const hit = all.filter(([key, c]) => wanted.includes(key) || wanted.includes(c.runId) || (c.rootSessionId && wanted.includes(c.rootSessionId)))
        return hit
      }
      // 结算判定：目标集合非空且全部 endedAt；目标为空则等当前所有活动子代理清零。
      const pending = (): string[] => {
        const targets = findTargets()
        return targets.filter(([, c]) => !c.endedAt).map(([key]) => key)
      }
      // 指定了 id 但一个都匹配不到：直接报错而不是假成功空等。
      if (wanted.length && findTargets().length === 0) {
        return {
          ok: false,
          timedOut: false,
          waitedMs: 0,
          error: '指定的 sessionIds 没有匹配到任何子代理（可用 subagent_wait 不带参数查看近期结算，或检查 id 是否正确）。',
          stillRunning: [],
          settled: [],
        }
      }
      while (Date.now() < deadline) {
        const rest = pending()
        if (!rest.length) break
        await new Promise((resolve) => setTimeout(resolve, pollMs))
      }
      const rest = pending()
      const targets = findTargets()
      const settled = targets
        .filter(([, c]) => c.endedAt)
        .sort((x, y) => (y[1].endedAt ?? 0) - (x[1].endedAt ?? 0))
        .slice(0, 20)
        .map(([key, c]) => ({
          sessionId: key,
          runId: c.runId,
          channel: c.channel,
          rootSessionId: c.rootSessionId ?? '',
          route: c.lastRoute
            ? { provider: c.lastRoute.provider, model: c.lastRoute.model, effort: c.lastRoute.effort ?? '', rewritten: c.lastRoute.rewritten }
            : { provider: '', model: '', effort: '', rewritten: false },
          stopReason: c.stopReason ?? '',
          durationMs: c.endedAt ? c.endedAt - c.startedAt : 0,
        }))
      return {
        ok: rest.length === 0,
        timedOut: rest.length > 0,
        waitedMs: Math.min(timeoutMs, Date.now() - (deadline - timeoutMs)),
        stillRunning: rest,
        settled,
        error: rest.length > 0 ? '等待超时：仍有子代理未结算。' : '',
      }
    },
  })
  const disposeWaitTool = ctx.tools.register(waitTool)

  // ── 提示词通告 ──
  let disposeSection: (() => void) | undefined
  /** 从当前 policy 动态构建角色路由表：模型改绑定/加角色后，新会话通告自动跟随。 */
  const buildGuidance = (): string => {
    const roleEntries = Object.entries(policy.presets).filter(([key]) => key.startsWith('role_'))
    const roleLines = roleEntries
      .map(([key, p]) => {
        const o = p.override
        const route = o.provider && o.model ? `${o.provider}/${o.model}` : '跟随父级/全局默认'
        const hint = ROLE_PRESET_HINTS.find((h) => h.key === key)?.hint ?? ''
        return `  - preset=${key}（${p.label}）：路由 ${route}${o.effort ? ' · 强度 ' + o.effort : ''}${hint ? '。适用：' + hint : ''}`
      })
    const roleBlock = roleLines.length
      ? '\n角色路由约定（用户已绑定模型；委派前按任务性质主动选择并经 subagent_route 应用，无需询问）：\n' + roleLines.join('\n') + '\n'
      : ''
    return [
      '本机已安装子代理路由台插件（dsh-subagent-routing-console）：子代理模型与思考强度由路由台统一托管。左侧栏修改配置后必须点击「保存路由」；保存成功后写入策略文件并立即影响后续委派，无需重启。全局默认必须包含完整 provider + model；会话/通道覆盖只能在路由台全局默认之上继承。host 经 /subagent-routing-console/* 路由提供策略读写与活动子代理监视。对话内可用 subagent_route 工具查询或修改路由策略：action=show 查看 / action=set 设置（scope=session 默认仅当前会话，scope=global 全局；provider+model 成对、effort 可选）/ action=preset 应用预设（preset 留空=列出全部）/ action=inherit 仅清除本会话覆盖；另有 subagent_wait 工具可等待后台子代理结算并回收结果；路由台不可关闭。用户提到「子代理模型 / 子代理思考强度 / 路由台」时即指本插件，请据此协作。',
      roleBlock +
      (roleEntries.length
        ? '委派前先判断任务性质：探索/检索→侦察，评审/审查→评审，架构/规划→架构；匹配到角色时用 subagent_route(action=preset, preset=<角色>, scope=session) 应用到当前会话再派发，一次会话内同性质任务无需重复应用。'
        : '') +
      [
        '\n子代理形态与路由语义：',
        '· 一次性子代理（subagent/workflow worker，跑完即止）：路由在其首请求时定型，改策略不影响已在跑的实例。',
        '· 可续接子代理（subagent_fork/后台子代理经 send_message 续聊）：每次续聊都是新请求、都会重新过路由——',
        '  改策略后续接子代理下一轮即吃新路由；反之给父会话应用的角色覆盖也会影响其后续轮。需要「换模型续跑」时，',
        '  先 subagent_route 改路由再 send_message；需要「保持原模型续跑」时不要动路由，或改用一次性子代理。',
      ].join('') +
      [
        '\n\n形态选择决策（派发前先回答两个问题：①任务会分几轮交互？②结果需要迭代修正吗？）：',
        '→ 用一次性子代理，当满足任意一条：',
        '  · 任务可一句话说清、交付物明确（「列出 X」「总结 Y」「翻译 Z」）；预期 1 轮即完成',
        '  · 并行扇出的独立子任务（互不依赖、失败可单独重发，无需续命）',
        '  · 结果是一次性消费（报告/答案/清单），后续由父会话自己消化',
        '→ 用可续接子代理，当满足任意一条：',
        '  · 任务需要多轮反馈修正（写代码→跑测试→按报错修，轮次不可预知）',
        '  · 需要中途插话补充信息/纠偏（steer），或分批交付（先骨架后细节）',
        '  · 上下文构建昂贵（fork 继承对话）且后续还要在其成果上继续工作',
        '· 量化经验值：预期交互轮次 1 轮 → 一次性；≥2 轮或轮次未知 → 可续接；',
        '  任务文本含「迭代/修正/按反馈/继续」等词 → 可续接；纯「查询/生成/转换」→ 一次性。',
        '· 成本视角：一次性失败即整体重来；可续接失败可原地纠偏但占常驻会话。不确定时选可续接（可随时弃用，反之不可补）。',
      ].join(''),
    ].join('')
  }
  const syncSection = (): void => {
    disposeSection?.()
    disposeSection = undefined
    disposeSection = ctx.systemPrompt.section({ name: 'plugin:subagent-router', order: SECTION_ORDER, text: buildGuidance() })
  }
  syncSection()

  ctx.logger?.info?.('[' + SHORT + '] 路由台就绪（enabled=' + policy.enabled + '，规则 ' + policy.rules.length + ' 条）')

  ctx.effect(() => () => {
    disposeSection?.()
    disposeTool()
    disposeWaitTool()
    for (const d of disposeRoutes) d()
    for (const d of disposeEvents) d?.()
  })
}
