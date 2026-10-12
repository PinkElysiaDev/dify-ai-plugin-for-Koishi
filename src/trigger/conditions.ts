import { Session } from 'koishi'
import { MessageTriggerType, TriggerCondition, TriggerScope } from '../types'
import { extractText } from '../utils/session-text'

export interface ConditionMatched {
  type: MessageTriggerType
  /** 触发后用作 content 变量的剥离文本（query 由引擎按统一消息格式另行构造） */
  queryText: string
}

function hasAt(session: Session, id: string): boolean {
  return session.elements?.some((element) => element.type === 'at' && element.attrs?.['id'] === id) ?? false
}

/** 评估单个消息条件；返回 null 表示未命中 */
export function evaluateCondition(
  condition: TriggerCondition,
  session: Session
): ConditionMatched | null {
  const text = extractText(session)
  switch (condition.type) {
    case 'keyword-prefix': {
      const keyword = condition.keywords.find((k) => k && text.startsWith(k))
      if (!keyword) return null
      const rest = text.slice(keyword.length).trim()
      return { type: 'keyword-prefix', queryText: rest || text }
    }
    case 'keyword-contains': {
      const keyword = condition.keywords.find((k) => k && text.includes(k))
      if (!keyword) return null
      return { type: 'keyword-contains', queryText: text }
    }
    case 'at-bot': {
      const botId = session.bot?.userId
      if (!botId) return null
      // 首选 koishi 内置的 atSelf（含「@ 在句首」语义），元素级判定兜底（@ 在任意位置）
      if (!session.stripped?.atSelf && !hasAt(session, botId)) return null
      return { type: 'at-bot', queryText: extractText(session, { excludeAt: true }) }
    }
    case 'at-user': {
      const isAtAnyUser = condition.userIds.some((id) => hasAt(session, id))
      if (!isAtAnyUser) return null
      return { type: 'at-user', queryText: text }
    }
    case 'quote-bot': {
      const botId = session.bot?.userId
      if (!botId || session.quote?.user?.id !== botId) return null
      return { type: 'quote-bot', queryText: extractText(session, { excludeAt: true }) }
    }
    case 'quote-user': {
      const author = session.quote?.user?.id
      if (!author || !condition.userIds.includes(author)) return null
      return { type: 'quote-user', queryText: extractText(session, { excludeAt: true }) }
    }
    default:
      // schedule / density 不是消息条件，由调度器与消息池处理
      return null
  }
}

/** 作用域过滤：留空的维度不做限制 */
export function matchScope(scope: TriggerScope, session: Session): boolean {
  const guildId = session.guildId ?? session.channelId
  const dimensions: Array<[string[] | undefined, string]> = [
    [scope.platforms, session.platform],
    [scope.selfIds, session.selfId],
    [scope.channelIds, session.channelId],
    [scope.guildIds, guildId],
    [scope.users, session.userId]
  ]
  if (dimensions.some(([allowed, value]) => allowed?.length && !allowed.includes(value))) return false
  if (scope.excludeUsers?.length && scope.excludeUsers.includes(session.userId)) return false
  if (scope.isDirect === true && !session.isDirect) return false
  if (scope.isDirect === false && session.isDirect) return false
  return true
}
