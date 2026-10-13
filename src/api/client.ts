import { Context } from 'koishi'
import {
  ChatBlockingResponse,
  CompletionBlockingResponse,
  DifyApiError,
  DifyAppInfo,
  DifyInputFileObject,
  DifyUploadFileResult,
  WorkflowBlockingResponse
} from './types'

/** 构造 DifyClient 所需的最小应用字段 */
export interface DifyClientApp {
  apiURL: string
  apiKey: string
}

type HttpMethod = Parameters<Context['http']>[0]

/** 错误消息里保留的响应体片段长度上限 */
const ERROR_MESSAGE_MAX = 300

/** 单次请求的缺省超时（毫秒） */
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000

export class DifyClient {
  constructor(
    private http: Context['http'],
    private app: DifyClientApp,
    private timeout = DEFAULT_REQUEST_TIMEOUT_MS
  ) {}

  private buildUrl(path: string) {
    return this.app.apiURL.replace(/\/+$/, '') + path
  }

  private authHeaders() {
    return { Authorization: `Bearer ${this.app.apiKey}` }
  }

  private buildJsonHeaders() {
    return { ...this.authHeaders(), 'Content-Type': 'application/json' }
  }

  private errorFrom(status: number, data: any, statusText = ''): DifyApiError {
    const isObject = typeof data === 'object' && data !== null
    const code = isObject && data.code != null ? String(data.code) : ''
    const message =
      (isObject && data.message) ||
      (typeof data === 'string' && data.slice(0, ERROR_MESSAGE_MAX)) ||
      statusText ||
      'unknown error'
    return new DifyApiError(`Dify API ${status}${code ? ` ${code}` : ''}: ${message}`, status, code)
  }

  /** 非 2xx 时抛出带状态码与 Dify 错误码的 DifyApiError */
  private ensureOk(status: number, data: any, statusText = '') {
    if (status >= 400) throw this.errorFrom(status, data, statusText)
  }

  /** blocking JSON 请求（本插件只用 blocking 模式） */
  private async request<T = any>(method: HttpMethod, path: string, body?: any): Promise<T> {
    const res = await this.http(method, this.buildUrl(path), {
      headers: this.buildJsonHeaders(),
      data: body,
      timeout: this.timeout,
      validateStatus: () => true
    })
    this.ensureOk(res.status, res.data, res.statusText)
    return res.data as T
  }

  getAppInfo(): Promise<DifyAppInfo> {
    return this.request<DifyAppInfo>('GET', '/info')
  }

  /** chat / agent-chat / advanced-chat（conversation_id 传空串表示新建会话） */
  runChat(body: {
    inputs: Record<string, any>
    query: string
    response_mode: 'blocking'
    user: string
    conversation_id?: string
    files?: DifyInputFileObject[]
    auto_generate_name?: boolean
  }): Promise<ChatBlockingResponse> {
    return this.request('POST', '/chat-messages', body)
  }

  /** workflow 应用 */
  runWorkflow(body: {
    inputs: Record<string, any>
    response_mode: 'blocking'
    user: string
    files?: DifyInputFileObject[]
  }): Promise<WorkflowBlockingResponse> {
    return this.request('POST', '/workflows/run', body)
  }

  /** 文本生成应用 */
  runCompletion(body: {
    inputs: Record<string, any>
    response_mode: 'blocking'
    user: string
    files?: DifyInputFileObject[]
  }): Promise<CompletionBlockingResponse> {
    return this.request('POST', '/completion-messages', body)
  }

  deleteConversation(conversationId: string, user: string): Promise<any> {
    return this.request('DELETE', `/conversations/${encodeURIComponent(conversationId)}`, { user })
  }

  async uploadFile(
    file: { data: Buffer | Uint8Array; filename: string; mime?: string },
    user: string
  ): Promise<DifyUploadFileResult> {
    const form = new FormData()
    form.set(
      'file',
      new Blob([file.data as BlobPart], { type: file.mime ?? 'application/octet-stream' }),
      file.filename
    )
    form.set('user', user)
    const res = await this.http('POST', this.buildUrl('/files/upload'), {
      headers: this.authHeaders(),
      data: form,
      timeout: this.timeout,
      validateStatus: () => true
    })
    // 该端点成功状态码是 201
    this.ensureOk(res.status, res.data, res.statusText)
    const data = res.data
    // 兼容不同版本返回 {id} 或 {data: {id}}
    const id = data?.id ?? data?.data?.id
    if (!id) throw new DifyApiError('Dify file upload returned no id', res.status)
    return { ...data, id }
  }
}

/**
 * 构造客户端的统一入口：凭据缺失时记 warn 并返回 null，
 * 调用方以此直接放弃本次操作。
 */
export function createDifyClient(
  ctx: Context,
  app: DifyClientApp & { name?: string },
  timeout?: number
): DifyClient | null {
  if (!app.apiURL || !app.apiKey) {
    ctx.logger.warn('应用 %s 缺少 apiURL 或 apiKey', app.name ?? app.apiURL)
    return null
  }
  return new DifyClient(ctx.http, app, timeout)
}
