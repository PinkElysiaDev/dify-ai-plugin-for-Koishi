import { createHash } from 'crypto'
import { h, Session } from 'koishi'

/** 图片占位符携带的 URL 摘要长度（hex 位） */
export const IMAGE_HASH_LENGTH = 8

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

/** 会话消息纯文本：优先 elements，退回 content 解析；统一 trim（@ 元素不产生文本，仅供条件匹配） */
export function extractText(session: Session): string {
  if (session.elements?.length) {
    return h.select(session.elements, 'text').join('').trim()
  }
  return parseTextSafe(session.content)
}

/** 消息中的图片元素在文本形态里的占位符（图片无 URL 时的兜底形态） */
export const IMAGE_PLACEHOLDER = '[图片]'

/** 图片占位符带 URL 摘要：同 URL 同标识，query 里的占位符与上传文件可全局对应 */
export function imagePlaceholder(url?: string): string {
  if (!url) return IMAGE_PLACEHOLDER
  return `[image:${createHash('sha1').update(url).digest('hex').slice(0, IMAGE_HASH_LENGTH)}]`
}

/** 给被丢弃图片的占位符追加已丢弃注记：按 URL 摘要全局定位，无需与元素顺序对齐 */
export function annotateDroppedPlaceholders(text: string, droppedUrls: string[]): string {
  let result = text
  for (const url of droppedUrls) {
    const placeholder = imagePlaceholder(url)
    result = result.split(placeholder).join(`${placeholder}（已丢弃）`)
  }
  return result
}

interface ExtractVerbatimOptions {
  /** 跳过 @ 机器人自身的渲染（content 变量语义：@bot 是触发结构而非消息内容） */
  excludeBotAt?: boolean
}

/** 图片元素判定（img 与 image 两种元素名，占位符渲染与 URL 提取共用） */
function isImageElement(element: h): boolean {
  return element.type === 'img' || element.type === 'image'
}

/** 媒体元素的源地址（url 或 src 属性，未定形态原样返回由调用方守卫） */
export function imageSourceOf(element: h): unknown {
  return element.attrs?.['url'] ?? element.attrs?.['src']
}

/** 会话消息元素：elements 为空时回退解析 content（各提取函数共用） */
function elementsOf(session: Session): h[] {
  if (session.elements?.length) return session.elements
  try {
    return h.parse(session.content ?? '')
  } catch {
    return []
  }
}

/**
 * 消息原貌文本：text 元素按序拼接，@ 元素渲染为 @名字（缺名字用 ID），
 * img/image 元素渲染为 [image:URL摘要]——统一格式行（query/池/历史）用默认形态，
 * content 变量通道用 excludeBotAt 形态剔除 @bot。
 */
export function extractTextWithPlaceholders(
  session: Session,
  options: ExtractVerbatimOptions = {}
): string {
  const parts: string[] = []
  for (const element of elementsOf(session)) {
    if (element.type === 'text') {
      const text = element.attrs?.['content'] ?? ''
      if (text) parts.push(text)
    } else if (element.type === 'at') {
      if (options.excludeBotAt && element.attrs?.['id'] === session.selfId) continue
      const name = element.attrs?.['name'] ?? element.attrs?.['id']
      if (name) parts.push(`@${name}`)
    } else if (isImageElement(element)) {
      parts.push(imagePlaceholder(imageSourceOf(element) as string | undefined))
    }
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

/** 消息中图片元素的 URL 列表（按元素序，与原貌文本中 [image:摘要] 的出现序一致） */
export function extractImageUrls(session: Session): string[] {
  const urls: string[] = []
  for (const element of elementsOf(session)) {
    if (!isImageElement(element)) continue
    const source = imageSourceOf(element)
    if (typeof source === 'string' && source) urls.push(source)
  }
  return urls
}
