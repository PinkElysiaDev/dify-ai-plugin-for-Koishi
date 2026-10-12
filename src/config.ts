import { Schema } from 'koishi'
import {
  ConversationScope,
  DifyRule,
  MetaField,
  SessionField,
  TriggerCondition,
  TriggerScope,
  VariableBinding
} from './types'

/* ================= schema 形态（配置页所见） ================= */

export type AppTypeSetting = 'auto' | 'chat' | 'agent-chat' | 'advanced-chat' | 'workflow' | 'completion'

export interface AppConfigEntry {
  name: string
  /** 会话绑定用的稳定标识；留空回退应用名 */
  appId: string
  apiURL: string
  apiKey: string
  appType: AppTypeSetting
}

/** 条件的 union-tagged 形态：选择分支后仅出现该分支的字段 */
export type ConditionEntry =
  | { type: 'keyword-prefix'; keywords: string }
  | { type: 'keyword-contains'; keywords: string }
  | { type: 'at-bot' }
  | { type: 'at-user'; userIds: string }
  | { type: 'quote-bot' }
  | { type: 'quote-user'; userIds: string }
  | { type: 'schedule'; cron?: string; intervalMinutes?: number }
  | { type: 'density'; densityCount?: number; densityWindowSeconds?: number }

/** 变量映射的条件分支形态：先选来源分支，再填该分支的字段（历史消息是独立分支） */
export type VariableEntry =
  | { source: 'session'; field: string; key: string }
  | { source: 'history'; field: string; limit?: number }
  | { source: 'meta'; field: string; key: string }

/** 作用域的一行：维度 + 值 */
export interface ScopeRow {
  dimension: string
  value: string
}

export interface RuleEntry {
  name: string
  enabled: boolean
  priority: number
  app: string
  conversationScope: string
  conditions: ConditionEntry[]
  scope: ScopeRow[]
  variables: VariableEntry[]
}

export interface Config {
  apps: AppConfigEntry[]
  rules: RuleEntry[]
  // 回复行为
  parseElements: boolean
  quoteTrigger: boolean
  maxSegmentLength: number
  uploadFiles: boolean
  // 运行参数
  requestTimeout: number
  historyLimit: number
  sendErrors: boolean
}

const appTypeSchema = Schema.union([
  Schema.const('auto').description('自动探测'),
  Schema.const('chat').description('Chatbot'),
  Schema.const('agent-chat').description('Agent'),
  Schema.const('advanced-chat').description('Chatflow'),
  Schema.const('workflow').description('Workflow'),
  Schema.const('completion').description('文本生成')
])

/** 条件分支：下拉选类型，仅显示所选类型的字段 */
const conditionSchema = Schema.union([
  Schema.object({
    type: Schema.const('keyword-prefix').required(),
    keywords: Schema.string().role('textarea').required().description('关键词，每行一个')
  }).default({ type: 'keyword-prefix', keywords: '' }).description('关键词开头'),
  Schema.object({
    type: Schema.const('keyword-contains').required(),
    keywords: Schema.string().role('textarea').required().description('关键词，每行一个')
  }).default({ type: 'keyword-contains', keywords: '' }).description('包含关键词'),
  Schema.object({
    type: Schema.const('at-bot').required()
  }).default({ type: 'at-bot' }).description('@ 机器人'),
  Schema.object({
    type: Schema.const('at-user').required(),
    userIds: Schema.string().role('textarea').required().description('用户 ID，每行一个')
  }).default({ type: 'at-user', userIds: '' }).description('@ 指定用户'),
  Schema.object({
    type: Schema.const('quote-bot').required()
  }).default({ type: 'quote-bot' }).description('引用机器人'),
  Schema.object({
    type: Schema.const('quote-user').required(),
    userIds: Schema.string().role('textarea').required().description('用户 ID，每行一个')
  }).default({ type: 'quote-user', userIds: '' }).description('引用指定用户'),
  Schema.object({
    type: Schema.const('schedule').required(),
    cron: Schema.string().default('').description('Cron 表达式'),
    intervalMinutes: Schema.number().default(0).min(0).description('间隔分钟')
  }).default({ type: 'schedule', cron: '', intervalMinutes: 0 }).description('定时'),
  Schema.object({
    type: Schema.const('density').required(),
    densityCount: Schema.natural().default(5).description('条数阈值'),
    densityWindowSeconds: Schema.natural().default(60).description('窗口秒数')
  }).default({ type: 'density', densityCount: 5, densityWindowSeconds: 60 }).description('消息密度')
])

/**
 * 会话字段变量的下拉选项（与 types.SessionField 一一对应）。
 * 默认值是哨兵「无」：任何真实变量都不与默认值相等，避免表单运行时
 * 「值等于默认值即置 null」的机制吞掉真实选择。
 */
const sessionKeySchema = Schema.union([
  Schema.const('none').description('无'),
  Schema.const('userId').description('用户 ID'),
  Schema.const('botId').description('Bot ID'),
  Schema.const('guildId').description('群聊 ID'),
  Schema.const('channelId').description('频道 ID'),
  Schema.const('platform').description('平台'),
  Schema.const('messageId').description('消息 ID'),
  Schema.const('content').description('触发文本'),
  Schema.const('quoteContent').description('被引用内容'),
  Schema.const('quoteAuthorId').description('被引用作者'),
  Schema.const('username').description('用户名'),
  Schema.const('timestamp').description('触发时间'),
  Schema.const('isDirect').description('是否私聊')
])

/** 触发元信息变量的下拉选项（与 types.MetaField 一一对应；默认哨兵「无」） */
const metaKeySchema = Schema.union([
  Schema.const('none').description('无'),
  Schema.const('triggerType').description('触发类型'),
  Schema.const('ruleName').description('规则名'),
  Schema.const('triggerTime').description('触发时间')
])

/**
 * 变量映射分支：选来源后仅显示该来源的配置项（纯对象结构）。
 * 历史消息是独立分支，条数只在选中该分支时显示——值驱动的条件显示
 * 在表单运行时不可实现（intersect 结构两度实证丢值），分支选择是条件下唯一联动方式。
 */
const variableSchema = Schema.union([
  Schema.object({
    source: Schema.const('session').required(),
    field: Schema.string().required().description('字段名'),
    key: sessionKeySchema.default('none').description('变量')
  }).default({ source: 'session', field: '', key: 'none' }).description('会话字段'),
  Schema.object({
    source: Schema.const('history').required(),
    field: Schema.string().required().description('字段名'),
    limit: Schema.natural().default(0).min(0).max(100).description('条数，0 用全局')
  }).default({ source: 'history', field: '', limit: 0 }).description('历史消息'),
  Schema.object({
    source: Schema.const('meta').required(),
    field: Schema.string().required().description('字段名'),
    key: metaKeySchema.default('none').description('变量')
  }).default({ source: 'meta', field: '', key: 'none' }).description('触发元信息')
])

export const Config: Schema<Config> = Schema.intersect([
  Schema.object({
    apps: Schema.array(
      Schema.object({
        name: Schema.string().required().description('应用名'),
        appId: Schema.string().default('').description('应用 ID，会话绑定用，留空取应用名'),
        apiURL: Schema.string().required().role('link').description('API 地址'),
        apiKey: Schema.string().required().role('secret').description('App Key'),
        appType: appTypeSchema.default('auto').description('应用类型')
      })
    )
      .role('table')
      .default([])
      .description('应用列表')
  }).description('应用配置'),

  Schema.object({
    rules: Schema.array(
      Schema.object({
        name: Schema.string().required().description('规则名'),
        enabled: Schema.boolean().default(true).description('启用'),
        priority: Schema.number().default(0).description('优先级，大者先匹配'),
        app: Schema.string().required().description('应用名'),
        conversationScope: Schema.union([
          Schema.const('per-guild').description('按群聊'),
          Schema.const('per-user').description('按用户'),
          Schema.const('per-channel').description('按频道'),
          Schema.const('global').description('全局')
        ])
          .default('per-guild')
          .description('会话粒度'),
        conditions: Schema.array(conditionSchema)
          .role('list')
          .default([])
          .description('触发条件，任一命中即触发'),
        scope: Schema.array(
          Schema.object({
            dimension: Schema.union([
              Schema.const('platform').description('平台'),
              Schema.const('selfId').description('Bot 账号'),
              Schema.const('guildId').description('群聊'),
              Schema.const('channelId').description('频道'),
              Schema.const('user').description('用户'),
              Schema.const('excludeUser').description('排除用户'),
              Schema.const('isDirect').description('会话类型，值为私聊或群聊')
            ])
              .required()
              .description('维度'),
            value: Schema.string().required().description('值')
          })
        )
          .role('table')
          .default([])
          .description('作用域'),
        variables: Schema.array(variableSchema)
          .role('list')
          .default([])
          .description('变量映射')
      })
    )
      .role('list')
      .default([])
      .description('触发规则')
  }).description('触发规则'),

  Schema.object({
    parseElements: Schema.boolean().default(false).description('解析回复中的消息元素'),
    quoteTrigger: Schema.boolean().default(true).description('引用触发消息'),
    maxSegmentLength: Schema.natural().default(0).description('分段长度，0 不分段'),
    uploadFiles: Schema.boolean().default(true).description('上传消息中的文件')
  }).description('回复行为'),

  Schema.object({
    requestTimeout: Schema.natural().role('ms').default(300000).description('请求超时'),
    historyLimit: Schema.natural().default(20).min(1).description('历史消息条数'),
    sendErrors: Schema.boolean().default(false).description('失败时提示错误')
  }).description('运行参数')
]) as Schema<Config>

/* ================= schema → 内部模型 ================= */

const CONVERSATION_SCOPES: ConversationScope[] = ['per-user', 'per-guild', 'per-channel', 'global']

/** 多行文本 → 非空行数组 */
function splitLines(value: string | undefined): string[] {
  return (value ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
}

/** 条件分支 → 判别联合；缺必填参数的条件返回 null（丢弃） */
function toCondition(entry: ConditionEntry): TriggerCondition | null {
  switch (entry.type) {
    case 'keyword-prefix':
    case 'keyword-contains': {
      const keywords = splitLines(entry.keywords)
      return keywords.length ? { type: entry.type, keywords } : null
    }
    case 'at-user':
    case 'quote-user': {
      const userIds = splitLines(entry.userIds)
      return userIds.length ? { type: entry.type, userIds } : null
    }
    case 'at-bot':
    case 'quote-bot':
      return { type: entry.type }
    case 'schedule': {
      const cron = entry.cron?.trim()
      const intervalMinutes = Number(entry.intervalMinutes)
      if (!cron && !(intervalMinutes > 0)) return null
      return {
        type: 'schedule',
        ...(cron ? { cron } : {}),
        ...(intervalMinutes > 0 ? { intervalMinutes } : {})
      }
    }
    case 'density':
      return {
        type: 'density',
        densityCount: Math.max(1, Number(entry.densityCount) || 1),
        densityWindowSeconds: Math.max(1, Number(entry.densityWindowSeconds) || 1)
      }
    default:
      return null
  }
}

/** 会话类型的值：私聊/群聊（兼容 true/false） */
function parseDirect(value: string): boolean | undefined {
  const normalized = value.trim()
  if (['私聊', 'true'].includes(normalized)) return true
  if (['群聊', 'false'].includes(normalized)) return false
  return undefined
}

/** 作用域表格行 → 内部 TriggerScope：按维度聚合；私聊/群聊同时出现视为不限 */
function toScope(rows: ScopeRow[]): TriggerScope {
  const buckets: Record<string, string[]> = {
    platform: [],
    selfId: [],
    guildId: [],
    channelId: [],
    user: [],
    excludeUser: []
  }
  let hasPrivate = false
  let hasGroup = false
  for (const row of rows ?? []) {
    const value = row.value?.trim()
    if (!value) continue
    if (row.dimension === 'isDirect') {
      const direct = parseDirect(value)
      if (direct === true) hasPrivate = true
      if (direct === false) hasGroup = true
      continue
    }
    buckets[row.dimension]?.push(value)
  }
  const prune = (values: string[]) => (values.length ? values : undefined)
  const isDirect = hasPrivate && !hasGroup ? true : hasGroup && !hasPrivate ? false : undefined
  return {
    platforms: prune(buckets.platform),
    selfIds: prune(buckets.selfId),
    guildIds: prune(buckets.guildId),
    channelIds: prune(buckets.channelId),
    users: prune(buckets.user),
    excludeUsers: prune(buckets.excludeUser),
    ...(isDirect === undefined ? {} : { isDirect })
  }
}

function toVariable(entry: VariableEntry): VariableBinding | null {
  const field = entry.field?.trim()
  if (!field) return null
  if (entry.source === 'meta') {
    // 哨兵「无」表示尚未选择变量，条目不生效
    if (entry.key === 'none') return null
    return { field, source: { type: 'meta', key: (entry.key || 'triggerType') as MetaField } }
  }
  if (entry.source === 'history') {
    const limit = Number(entry.limit)
    return { field, source: { type: 'history', ...(limit > 0 ? { limit } : {}) } }
  }
  // 「无」未选择；历史消息塞在会话字段下拉里的旧形态（≤0.1.2 与 intersect 试验期）不做兼容
  if (entry.key === 'none' || entry.key === 'history') return null
  return { field, source: { type: 'session', key: (entry.key || 'content') as SessionField } }
}

/**
 * 配置规范化：应用表 + 按优先级降序的规则列表。
 * 坏条件/无名变量直接丢弃；引用不存在应用的规则保留但运行时会 warn 跳过。
 */
export function normalizeConfig(config: Config): { apps: Map<string, AppConfigEntry>; rules: DifyRule[] } {
  const apps = new Map<string, AppConfigEntry>()
  for (const app of config.apps ?? []) {
    if (app.name?.trim() && !apps.has(app.name)) apps.set(app.name, app)
  }

  const rules: DifyRule[] = []
  for (const entry of config.rules ?? []) {
    if (!entry.name?.trim() || entry.enabled === false) continue
    // 条目可能为 null：表单缺陷时期保存的脏数据形态，跳过即可
    const conditions = (entry.conditions ?? [])
      .filter((condition): condition is ConditionEntry => condition != null)
      .map(toCondition)
      .filter((condition): condition is TriggerCondition => condition != null)
    const variables = (entry.variables ?? [])
      .filter((variable): variable is VariableEntry => variable != null)
      .map(toVariable)
      .filter((variable): variable is VariableBinding => variable != null)
    rules.push({
      name: entry.name.trim(),
      enabled: true,
      priority: Number(entry.priority) || 0,
      app: entry.app?.trim() ?? '',
      conditions,
      scope: toScope(entry.scope ?? []),
      variables,
      conversationScope: CONVERSATION_SCOPES.includes(entry.conversationScope as ConversationScope)
        ? (entry.conversationScope as ConversationScope)
        : 'per-guild'
    })
  }
  rules.sort((a, b) => b.priority - a.priority)
  return { apps, rules }
}
