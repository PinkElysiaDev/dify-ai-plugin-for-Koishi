import type { Session } from 'koishi'

/** 消息驱动的触发原因（merged = 冷却期内多条触发消息合并为一次触发） */
export type MessageTriggerType =
  | 'keyword-prefix'
  | 'keyword-contains'
  | 'at-bot'
  | 'at-user'
  | 'quote-bot'
  | 'quote-user'
  | 'merged'

/** 非消息驱动的触发原因 */
export type ProactiveTriggerType = 'schedule' | 'density'

export type TriggerType = MessageTriggerType | ProactiveTriggerType

/** 是否由消息触发（合并触发也算）：定时与密度触发没有单一触发消息 */
export function isMessageTrigger(type: TriggerType): boolean {
  return type !== 'schedule' && type !== 'density'
}

/** 关键词条件（prefix 触发时剥离关键词作为 query，contains 保留全文） */
export interface KeywordCondition {
  type: 'keyword-prefix' | 'keyword-contains'
  keywords: string[]
}

/** @ 指定用户 / 引用指定用户的消息 */
export interface UserCondition {
  type: 'at-user' | 'quote-user'
  userIds: string[]
}

/** @ 机器人（无参数） */
export interface AtBotCondition {
  type: 'at-bot'
}

/** 引用机器人自己的消息（无参数） */
export interface QuoteBotCondition {
  type: 'quote-bot'
}

/** 定时触发：cron（服务器本地时区）与固定间隔分钟数二选一 */
export interface ScheduleCondition {
  type: 'schedule'
  cron?: string
  intervalMinutes?: number
}

/** 消息密度触发：窗口内消息条数达到阈值即触发 */
export interface DensityCondition {
  type: 'density'
  densityCount: number
  densityWindowSeconds: number
}

/**
 * 触发条件（判别联合）。规则内多个条件为「或」关系：任一命中即触发。
 * 由 normalizeConfig 保证加载形态合法，消费方无需再兜底必填字段。
 */
export type TriggerCondition =
  | KeywordCondition
  | UserCondition
  | AtBotCondition
  | QuoteBotCondition
  | ScheduleCondition
  | DensityCondition

/** 触发作用域：留空的维度不做限制 */
export interface TriggerScope {
  platforms?: string[]
  selfIds?: string[]
  guildIds?: string[]
  channelIds?: string[]
  users?: string[]
  excludeUsers?: string[]
  /** true 仅私聊 / false 仅群聊 / 不设置则两者皆可 */
  isDirect?: boolean
}

/** 变量来源：从会话上下文取值 */
export type SessionField =
  | 'userId'
  | 'botId'
  | 'guildId'
  | 'channelId'
  | 'platform'
  | 'messageId'
  | 'content'
  | 'quoteContent'
  | 'quoteAuthorId'
  | 'username'
  | 'timestamp'
  | 'isDirect'

/** 变量来源：触发元信息 */
export type MetaField = 'triggerType' | 'ruleName' | 'triggerTime'

export type VariableSource =
  | { type: 'session'; key: SessionField }
  | { type: 'history'; limit?: number }
  | { type: 'meta'; key: MetaField }
  | { type: 'constant'; value: string }

/** 一条变量映射：Dify inputs 字段名 ← 来源 */
export interface VariableBinding {
  field: string
  source: VariableSource
}

/** Dify 会话绑定粒度 */
export type ConversationScope = 'per-user' | 'per-guild' | 'per-channel' | 'global'

/** 触发后冷却设置（schema 规范化后的内部形态；null 表示关闭） */
export type CooldownSetting =
  | { mode: 'fixed'; ms: number }
  | { mode: 'sliding'; minMs: number; maxMs: number }

/** 触发规则（配置页 schema 规范化后的内部形态；身份即 name，按优先级降序排列） */
export interface DifyRule {
  name: string
  enabled: boolean
  priority: number
  /** 关联应用名（Config.apps 里的 name） */
  app: string
  conditions: TriggerCondition[]
  scope: TriggerScope
  variables: VariableBinding[]
  conversationScope: ConversationScope
}

/** 一次触发运行的完整上下文（消息触发与定时摘要通用） */
export interface FireContext {
  /** 消息触发与密度触发时存在；定时摘要触发时为空 */
  session?: Session
  platform: string
  selfId: string
  channelId: string
  guildId?: string
  userId?: string
  triggerType: TriggerType
  rule: DifyRule
  /** 发给 Dify 的 query：统一消息格式（消息触发为单行，窗口触发为逐行拼接） */
  queryText: string
  /** content 变量的值：消息触发为剥离文本（剔除 @bot），窗口触发为精简行拼接 */
  contentText: string
  /** 本次触发相关消息的图片 URL（合并/密度/定时的池或缓冲条目合集）：供上传管线补齐非首条消息的图片 */
  imageUrls?: string[]
  /** 无 session 的主动触发（定时/密度到期）从消息池透传的私聊标记：会话绑定与 isDirect 变量用 */
  isDirect?: boolean
}
