import { Session } from 'koishi'
import { extractTextWithPlaceholders } from './utils/session-text'
import { channelKeyOf } from './utils/keys'

/** 被引用消息的呈现所需字段（无消息 ID，与格式规范一致） */
export interface QuotedMessage {
  timestamp: number
  userId: string
  username: string
  content: string
}

export interface HistoryEntry {
  role: 'user' | 'assistant'
  userId: string
  username: string
  messageId?: string
  /** 纯文本 + 图片占位符 */
  content: string
  timestamp: number
  quote?: QuotedMessage
}

/** 缓冲容量相对默认条数的放大倍数与下限（防长窗口的密度统计被截断） */
const HISTORY_CAPACITY_MULTIPLIER = 2
const MIN_HISTORY_CAPACITY = 64

/** 消息时间戳 → 本地时区 YYYY-MM-DD HH:mm:ss */
function formatTimestamp(timestamp: number): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  const date = new Date(timestamp)
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  )
}

/**
 * 统一消息格式（历史消息变量 / 定时摘要 / 密度触发共用）：
 * `[时间] 昵称 (用户ID) [msg:消息ID]（引用了 [时间] 昵称 (用户ID) 说：内容）说：内容`
 * 引用段与外层同构但不展示消息 ID；无引用则整段省略。
 */
export function formatHistoryEntry(entry: HistoryEntry): string {
  const quote = entry.quote
    ? `（引用了 [${formatTimestamp(entry.quote.timestamp)}] ${entry.quote.username} (${entry.quote.userId}) 说：${entry.quote.content}）`
    : ''
  const messageId = entry.messageId ? ` [msg:${entry.messageId}]` : ''
  return `[${formatTimestamp(entry.timestamp)}] ${entry.username} (${entry.userId})${messageId}${quote}${quote ? '' : ' '}说：${entry.content}`
}

/** 多条消息逐行拼接 */
export function formatHistoryEntries(entries: HistoryEntry[]): string {
  return entries.map(formatHistoryEntry).join('\n')
}

function buildQuote(session: Session): QuotedMessage | undefined {
  const quote = session.quote
  if (!quote?.user?.id) return undefined
  return {
    timestamp: quote.timestamp ? quote.timestamp * 1000 : Date.now(),
    userId: quote.user.id,
    username: quote.user.name || quote.user.id,
    content: extractTextWithPlaceholders({ ...session, elements: undefined, content: quote.content } as Session)
  }
}

/** 从会话消息构造记录条目（历史缓冲 / 密度窗口 / 定时窗口共用） */
export function buildHistoryEntry(session: Session, role: 'user' | 'assistant' = 'user'): HistoryEntry | null {
  const content = extractTextWithPlaceholders(session)
  if (!content) return null
  return {
    role,
    userId: role === 'assistant' ? session.selfId : session.userId ?? '未知用户',
    username: role === 'assistant' ? 'bot' : session.username || session.userId || '用户',
    messageId: session.messageId,
    content,
    timestamp: session.timestamp ?? Date.now(),
    quote: role === 'user' ? buildQuote(session) : undefined
  }
}

/**
 * 每个频道在内存中保留最近消息（含 bot 自己的回复），
 * 供「历史消息注入」变量与密度触发使用。重启后清空，属可接受损耗。
 */
export class MessageHistory {
  private buffers = new Map<string, HistoryEntry[]>()

  constructor(public limit = 20) {}

  recordEntry(channelKey: string, entry: HistoryEntry) {
    let buffer = this.buffers.get(channelKey)
    if (!buffer) {
      buffer = []
      this.buffers.set(channelKey, buffer)
    }
    buffer.push(entry)
    const capacity = Math.max(this.limit * HISTORY_CAPACITY_MULTIPLIER, MIN_HISTORY_CAPACITY)
    if (buffer.length > capacity) buffer.splice(0, buffer.length - capacity)
  }

  get(channelKey: string, limit = this.limit): HistoryEntry[] {
    return (this.buffers.get(channelKey) ?? []).slice(-limit)
  }

  /** 序列化为统一消息格式的逐行拼接（变量值即完整聊天记录文本） */
  toVariable(entries: HistoryEntry[]): string {
    return formatHistoryEntries(entries)
  }
}
