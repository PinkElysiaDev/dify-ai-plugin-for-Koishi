import { Session } from 'koishi'
import { MessageTriggerType, TriggerCondition, TriggerScope } from '../types'
import { extractText, extractTextWithPlaceholders, IMAGE_HASH_LENGTH, IMAGE_PLACEHOLDER } from '../utils/session-text'

export interface ConditionMatched {
  type: MessageTriggerType
  /** content 变量的剥离文本，保留 @ 与图片占位（query 由引擎按统一消息格式另行构造） */
  contentText: string
}

function hasAt(session: Session, id: string): boolean {
  return session.elements?.some((element) => element.type === 'at' && element.attrs?.['id'] === id) ?? false
}

/** 正则字符组转义（占位符字面量 [图片] 中的方括号） */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 原貌开头的非正文前缀（@渲染 / 图片占位 / 空白）序列；占位符与 imagePlaceholder 同源 */
const NON_TEXT_PREFIX = new RegExp(
  `^(?:@\\S+|\\[image:[0-9a-f]{${IMAGE_HASH_LENGTH}}\\]|${escapeRegExp(IMAGE_PLACEHOLDER)}|\\s)*`
)

/**
 * 前缀感知剥离：原貌以「非正文前缀 + 关键词」开头时剥掉关键词并保留前缀
 * （如 `[image:x] 查这张` → `[image:x] 这张`）；不匹配返回 null。
 */
function stripPrefixKeyword(verbatim: string, keyword: string): string | null {
  const prefix = NON_TEXT_PREFIX.exec(verbatim)?.[0] ?? ''
  const rest = verbatim.slice(prefix.length)
  if (!rest.startsWith(keyword)) return null
  return (prefix + rest.slice(keyword.length)).trim()
}

/** 评估单个消息条件；返回 null 表示未命中（匹配基于纯文本，@ 元素不参与判定） */
export function evaluateCondition(
  condition: TriggerCondition,
  session: Session
): ConditionMatched | null {
  const text = extractText(session)
  // content 变量通道剔除 @bot（触发结构非消息内容）；query 通道的统一格式行仍保留
  const verbatim = extractTextWithPlaceholders(session, { excludeBotAt: true })
  switch (condition.type) {
    case 'keyword-prefix': {
      const keyword = condition.keywords.find((k) => k && text.startsWith(k))
      if (!keyword) return null
      // 原貌域剥离优先（含前缀感知），保住 @ 与图片占位；均不匹配才退回纯文本剥离
      const rest = verbatim.startsWith(keyword)
        ? verbatim.slice(keyword.length).trim()
        : stripPrefixKeyword(verbatim, keyword) ?? text.slice(keyword.length).trim()
      return { type: 'keyword-prefix', contentText: rest || verbatim }
    }
    case 'keyword-contains': {
      const keyword = condition.keywords.find((k) => k && text.includes(k))
      if (!keyword) return null
      return { type: 'keyword-contains', contentText: verbatim }
    }
    case 'at-bot': {
      const botId = session.bot?.userId
      if (!botId) return null
      // 首选 koishi 内置的 atSelf（含「@ 在句首」语义），元素级判定兜底（@ 在任意位置）
      if (!session.stripped?.atSelf && !hasAt(session, botId)) return null
      return { type: 'at-bot', contentText: verbatim }
    }
    case 'at-user': {
      const isAtAnyUser = condition.userIds.some((id) => hasAt(session, id))
      if (!isAtAnyUser) return null
      return { type: 'at-user', contentText: verbatim }
    }
    case 'quote-bot': {
      const botId = session.bot?.userId
      if (!botId || session.quote?.user?.id !== botId) return null
      return { type: 'quote-bot', contentText: verbatim }
    }
    case 'quote-user': {
      const author = session.quote?.user?.id
      if (!author || !condition.userIds.includes(author)) return null
      return { type: 'quote-user', contentText: verbatim }
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
  if (scope.isDirect != null && scope.isDirect !== !!session.isDirect) return false
  return true
}
