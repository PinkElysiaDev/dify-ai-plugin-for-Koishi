import { FireContext, JSON_PLACEHOLDER, MetaField, SessionField, VariableSource } from '../types'
import { buildQuote, formatQuotedMessage, MessageHistory } from '../history'
import { DifyRule } from '../types'
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
    case 'quoteContent': {
      // 引用段完整形态（时间+作者+内容，与统一格式行同源）；无引用或无 session（cron/frequency 触发）为空串
      const quote = session ? buildQuote(session) : undefined
      return quote ? formatQuotedMessage(quote) : ''
    }
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

/** 历史消息变量：条数默认与 MessageHistory 实例同源（config.historyLimit） */
function historyVariableOf(fireCtx: FireContext, history: MessageHistory, limit?: number) {
  const channelKey = channelKeyOf(fireCtx.platform, fireCtx.channelId)
  return history.toVariable(history.get(channelKey, limit ?? history.limit))
}

function resolveSource(
  source: VariableSource,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
) {
  switch (source.type) {
    case 'session':
      return resolveSessionField(source.key, fireCtx, now)
    case 'meta':
      return resolveMetaField(source.key, fireCtx, now)
    case 'constant':
      return source.value
    case 'history':
      return historyVariableOf(fireCtx, history, source.limit)
    default:
      return undefined
  }
}

/** 占位符可引用的元信息变量（其余名字走会话字段） */
const META_PLACEHOLDERS = new Set<MetaField>(['triggerType', 'ruleName', 'triggerTime'])

/**
 * 占位符求值（与现有变量系统一一对应），返回原生值：
 * isDirect 为布尔（类型保真），其余 12 会话字段、3 元信息与 history[:N] 为字符串，
 * 未知或无值得空串。
 */
function resolvePlaceholderValue(
  name: string,
  limit: number | undefined,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
): boolean | string {
  if (name === 'history') {
    return historyVariableOf(fireCtx, history, limit)
  }
  if (name === 'isDirect') {
    return resolveSessionField('isDirect', fireCtx, now)
  }
  if (META_PLACEHOLDERS.has(name as MetaField)) {
    return resolveMetaField(name as MetaField, fireCtx, now)
  }
  return String(resolveSessionField(name as SessionField, fireCtx, now))
}

/** 裸占位符字符串值（"{{x}}" 整串含引号）：替换为原生值的 JSON 字面量，类型随之保真 */
const BARE_PLACEHOLDER = new RegExp(`"${JSON_PLACEHOLDER.source}"`, 'g')

/** 字符串内的混合占位符转义嵌入（引号、反斜杠、换行等），不破坏 JSON 结构 */
const escapeJsonText = (value: string) => JSON.stringify(value).slice(1, -1)

/** 模板插值：先裸占位符（原生字面量），后字符串内混合占位符（转义拼接） */
function interpolateTemplate(
  template: string,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
): string {
  const resolve = (name: string, limit?: string) =>
    resolvePlaceholderValue(name, limit ? Number(limit) : undefined, fireCtx, history, now)
  const bareReplaced = template.replace(BARE_PLACEHOLDER, (_match, name: string, limit?: string) =>
    JSON.stringify(resolve(name, limit))
  )
  return bareReplaced.replace(JSON_PLACEHOLDER, (_match, name: string, limit?: string) =>
    escapeJsonText(String(resolve(name, limit)))
  )
}

/** JSON 对象模板插值并解析：顶层键即 inputs 字段，嵌套对象即 object 变量值；失败返回 null（条目整体跳过） */
function resolveJsonObject(
  template: string,
  fireCtx: FireContext,
  history: MessageHistory,
  now: string
): Record<string, any> | null {
  try {
    const parsed = JSON.parse(interpolateTemplate(template, fireCtx, history, now))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * 按规则的变量映射表构造 Dify inputs。
 * JSON 对象条目作为单一变量整体注入 inputs[字段名]（适配 Dify json_object 特性，
 * 字段名即 Dify 侧该 object 变量的名字）；单条映射后注入覆盖同名键。
 */
export function resolveVariables(
  rule: DifyRule,
  fireCtx: FireContext,
  history: MessageHistory
): Record<string, any> {
  const inputs: Record<string, any> = {}
  const now = new Date().toISOString()
  for (const binding of rule.variables) {
    if (binding.source.type !== 'json') continue
    const object = resolveJsonObject(binding.source.template, fireCtx, history, now)
    if (object) inputs[binding.field] = object
  }
  for (const binding of rule.variables) {
    if (binding.source.type === 'json') continue
    const value = resolveSource(binding.source, fireCtx, history, now)
    if (value !== undefined) inputs[binding.field] = value
  }
  return inputs
}
