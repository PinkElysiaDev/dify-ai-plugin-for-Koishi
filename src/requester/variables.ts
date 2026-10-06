import { FireContext, MetaField, SessionField, VariableSource } from '../types'
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
      return fireCtx.queryText
    case 'quoteContent':
      return parseTextSafe(session?.quote?.content)
    case 'quoteAuthorId':
      return session?.quote?.user?.id ?? ''
    case 'username':
      return session?.username ?? fireCtx.userId ?? ''
    case 'timestamp':
      return now
    case 'isDirect':
      return session?.isDirect ?? false
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

/** 按规则的变量映射表构造 Dify inputs */
export function resolveVariables(
  rule: DifyRule,
  fireCtx: FireContext,
  history: MessageHistory
): Record<string, any> {
  const inputs: Record<string, any> = {}
  const now = new Date().toISOString()
  for (const binding of rule.variables) {
    if (!binding?.field) continue
    const value = resolveSource(binding.source, fireCtx, history, now)
    if (value !== undefined) inputs[binding.field] = value
  }
  return inputs
}
