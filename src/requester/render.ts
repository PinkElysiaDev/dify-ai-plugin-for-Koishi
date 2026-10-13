import { h } from 'koishi'
import { Config } from '../config'
import { DifyFilePayload } from '../api/types'

export interface RenderInput {
  text: string
  files: DifyFilePayload[]
  /** 引用哪条消息；调用方完成开关与耗时判定，未达标传空即不引用 */
  quoteMessageId?: string
  /** 回复行为配置（koishi schema「回复行为」组） */
  config: Config
}

function splitText(text: string, maxLength: number): string[] {
  if (!text) return []
  if (!(maxLength > 0)) return [text]
  const lines = text.split('\n')
  const segments: string[] = []
  let current = ''
  const flush = () => {
    if (current) segments.push(current)
  }
  for (const line of lines) {
    // 单行超长时硬切
    if (line.length > maxLength) {
      flush()
      current = ''
      for (let i = 0; i < line.length; i += maxLength) {
        segments.push(line.slice(i, i + maxLength))
      }
      continue
    }
    if (current && current.length + line.length + 1 > maxLength) {
      segments.push(current)
      current = line
    } else {
      current = current ? `${current}\n${line}` : line
    }
  }
  flush()
  return segments
}

/**
 * 把 Dify 回复渲染为待发送的 koishi 消息列表（每条消息是元素数组）。
 * parseElements=false 时用 h.text 保证 LLM 输出中的尖括号按字面发送。
 */
export function renderReply(input: RenderInput): h[][] {
  const messages: h[][] = []
  const segments = splitText(input.text, input.config.maxSegmentLength)
  segments.forEach((segment, index) => {
    const elements: h[] = []
    if (index === 0 && input.quoteMessageId) {
      elements.push(h.quote(input.quoteMessageId))
    }
    if (input.config.parseElements) {
      elements.push(...h.parse(segment))
    } else {
      elements.push(h.text(segment))
    }
    messages.push(elements)
  })
  for (const file of input.files) {
    messages.push(file.type === 'image' ? [h.image(file.url)] : [h.text(file.url)])
  }
  return messages
}
