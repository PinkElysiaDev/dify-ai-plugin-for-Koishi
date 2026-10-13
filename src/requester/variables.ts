import { FireContext, JSON_PLACEHOLDER, MetaField, SessionField, VariableSource } from '../types'
import { MessageHistory } from '../history'
import { DifyRule } from '../types'
import { parseTextSafe } from '../utils/session-text'
import { channelKeyOf } from '../utils/keys'

function resolveSessionField(key: SessionField, fireCtx: FireContext, now: string) {
  const session = fireCtx.session
  switch (key) {
    case 'userId':
      return fireCtx.userId ?? session?.userId ?? ''
    case 'botId':
      return fireCtx.selfId ?? session?.selfId ?? ''
    case 'guildId':
      return fireCtx.guildId ?? ''
    case 'channelId':
      return fireCtx.channelId
    case 'platform':
      return fireCtx.platform
    case 'messageId':
      return session?.messageId ?? ''
    case 'content':
      return fireCtx.contentText
    case 'quoteContent':
      return parseTextSafe(session?.quote?.content)
    case 'quoteAuthorId':
      return session?.quote?.user?.id ?? ''
    case 'username':
      return session?.username ?? fireCtx.userId ?? ''
    case 'timestamp':
      return now
    case 'isDirect':
      return session?.isDirect ?? fireCtx.isDirect ?? false
    default:
      // 变量绑定来自用户配置，key 可能是任意字符串
      return ''
  }
}

function resolveMetaField(key: MetaField, fireCtx: FireContext, now: string) {
  switch (key) {
    case 'triggerType':
      return fireCtx.triggerType
    case 'ruleName':
      return fireCtx.rule.name
    case 'triggerTime':
      return now
    default:
      return ''
  }
}

function resolveSource(
  source: VariableSource,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
) {
  switch (source?.type) {
    case 'session':
      return resolveSessionField(source.key, fireCtx, now)
    case 'meta':
      return resolveMetaField(source.key, fireCtx, now)
    case 'constant':
      return source.value
    case 'history': {
      const channelKey = channelKeyOf(fireCtx.platform, fireCtx.channelId)
      // 默认条数与 MessageHistory 实例同源（config.historyLimit），不再单独写死
      const limit = source.limit ?? history.limit
      return history.toVariable(history.get(channelKey, limit))
    }
    default:
      return undefined
  }
}

/** 占位符可引用的元信息变量（其余名字走会话字段） */
const META_PLACEHOLDERS = new Set<MetaField>(['triggerType', 'ruleName', 'triggerTime'])

/** 占位符求值：与现有变量系统一一对应（12 会话字段 + 3 元信息 + history[:N]），未知或无值得空串 */
function resolvePlaceholder(
  name: string,
  limit: number | undefined,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
): string {
  if (name === 'history') {
    const channelKey = channelKeyOf(fireCtx.platform, fireCtx.channelId)
    return history.toVariable(history.get(channelKey, limit ?? history.limit))
  }
  if (META_PLACEHOLDERS.has(name as MetaField)) {
    return String(resolveMetaField(name as MetaField, fireCtx, now) ?? '')
  }
  const value = resolveSessionField(name as SessionField, fireCtx, now)
  return value === undefined || value === null ? '' : String(value)
}

/** JSON 对象模板插值并解析：顶层键即 inputs 字段，嵌套对象即 object 变量值；失败返回 null（条目整体跳过） */
function resolveJsonObject(
  template: string,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
): Record<string, any> | null {
  const interpolated = template.replace(JSON_PLACEHOLDER, (_match, name: string, limit?: string) =>
    resolvePlaceholder(name, limit ? Number(limit) : undefined, fireCtx, history, now)
  )
  try {
    const parsed = JSON.parse(interpolated)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 按规则的变量映射表构造 Dify inputs。
 * JSON 对象条目先注入（顶层键展开合并进 inputs），单条映射后注入覆盖同名键——
 * 现有单条配置行为不变，JSON 作为批量默认值。
 */
export function resolveVariables(
  rule: DifyRule,
  fireCtx: FireContext,
  history: MessageHistory
): Record<string, any> {
  const inputs: Record<string, any> = {}
  const now = new Date().toISOString()
  for (const binding of rule.variables) {
    if (binding?.source?.type !== 'json') continue
    const object = resolveJsonObject(binding.source.template, fireCtx, history, now)
    if (object) Object.assign(inputs, object)
  }
  for (const binding of rule.variables) {
    if (!binding?.field || binding.source?.type === 'json') continue
    const value = resolveSource(binding.source, fireCtx, history, now)
    if (value !== undefined) inputs[binding.field] = value
  }
  return inputs
}
