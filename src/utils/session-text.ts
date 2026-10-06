import { h, Session } from 'koishi'

/**
 * 会话文本提取的统一入口。此前有四个变体（条件匹配、历史记录、变量、@ 剥离）
 * 各自实现「elements 有则取 text 元素，否则解析 content」，trim 与解析行为已经漂移，
 * 导致同一条消息在关键词匹配与历史记录里文本不一致。收口到这里统一行为。
 */

/** 把可解析的消息文本（含元素标记）转纯文本；解析失败回退原文 */
export function parseTextSafe(content: string | undefined): string {
  if (!content) return ''
  try {
    return h.select(h.parse(content), 'text').join('').trim()
  } catch {
    return content.trim()
  }
}

interface ExtractTextOptions {
  /** 去掉 @ 元素（at-bot 触发的 query 语义） */
  excludeAt?: boolean
}

/** 会话消息纯文本：优先 elements，退回 content 解析；统一 trim */
export function extractText(session: Session, options: ExtractTextOptions = {}): string {
  if (session.elements?.length) {
    const elements = options.excludeAt
      ? session.elements.filter((element) => element.type !== 'at')
      : session.elements
    return h.select(elements, 'text').join('').trim()
  }
  return parseTextSafe(session.content)
}

/** 消息中的图片元素在文本形态里的占位符 */
export const IMAGE_PLACEHOLDER = '[图片]'

/**
 * 带媒体占位符的消息文本：text 元素按序拼接，img/image 元素渲染为 [图片]，
 * 供聊天记录呈现（历史消息变量 / 定时摘要 / 密度触发共用）。
 */
export function extractTextWithPlaceholders(session: Session): string {
  const elements = session.elements?.length
    ? session.elements
    : (() => {
        try {
          return h.parse(session.content ?? '')
        } catch {
          return []
        }
      })()
  const parts: string[] = []
  for (const element of elements) {
    if (element.type === 'text') {
      const text = element.attrs?.['content'] ?? ''
      if (text) parts.push(text)
    } else if (element.type === 'img' || element.type === 'image') {
      parts.push(IMAGE_PLACEHOLDER)
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}
