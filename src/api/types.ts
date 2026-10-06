/** Dify 应用类型（GET /info 返回的 mode 字段） */
export type DifyAppMode = 'chat' | 'agent-chat' | 'advanced-chat' | 'workflow' | 'completion'

export interface DifyAppInfo {
  name: string
  description?: string
  tags?: string[]
  mode: DifyAppMode
  author_name?: string
}

export interface DifyInputFileObject {
  type: 'image' | 'document' | 'audio' | 'video' | 'custom'
  transfer_method: 'remote_url' | 'local_file'
  url?: string
  upload_file_id?: string
}

/** workflow outputs 里的文件对象形态 */
export interface DifyFilePayload {
  url: string
  type?: string
}

/* ---------- blocking 响应（只建模本插件消费的字段） ---------- */

/** POST /chat-messages（blocking）：完整回复 + 会话 id */
export interface ChatBlockingResponse {
  answer: string
  conversation_id?: string
}

/** POST /workflows/run（blocking）：结果都在 data 内 */
export interface WorkflowBlockingResponse {
  data: {
    id?: string
    /** succeeded / failed / stopped / partial-succeeded / paused */
    status?: string
    outputs?: Record<string, any> | null
    error?: string | null
    total_tokens?: number
  }
}

/** POST /completion-messages（blocking）：文本生成应用无会话概念 */
export interface CompletionBlockingResponse {
  answer: string
}

export interface DifyUploadFileResult {
  id: string
  name?: string
  mime_type?: string
  size?: number
  [key: string]: any
}

export class DifyApiError extends Error {
  constructor(message: string, public status = 0, public code = '') {
    super(message)
    this.name = 'DifyApiError'
  }
}
