import { Context, h } from 'koishi'
import { AppConfigEntry, Config } from '../config'
import { DifyRule, FireContext } from '../types'
import { MessageHistory } from '../history'
import { createDifyClient, DifyClient } from '../api/client'
import { uploadMessageFiles } from './files'
import {
  DifyApiError,
  DifyFilePayload,
  DifyInputFileObject,
  WorkflowBlockingResponse
} from '../api/types'
import { ConversationStore } from '../state/conversation'
import { resolveVariables } from './variables'
import { renderReply } from './render'
import { errorMessage } from '../utils/errors'

/** 一次请求的产出（blocking 响应解析后的统一形态） */
interface DifyReply {
  text: string
  files: DifyFilePayload[]
}

/** 密度触发没有触发消息时使用的占位 query（Dify 要求非空） */
const FALLBACK_QUERY = '（本次由系统触发，请参考变量中的上下文）'

/** workflow 被视为成功的状态 */
const SUCCESS_STATUSES = ['succeeded', 'partial-succeeded']

/** 探测失败或未指定类型时的回退路径（chat 端点对 chat 系全兼容） */
const FALLBACK_APP_TYPE = 'chat'

function isFileObject(value: any): value is { url: string; type?: string } {
  return typeof value === 'object' && value !== null && typeof value.url === 'string' && value.url !== ''
}

/** 从 workflow outputs 中收集文件对象（值或数组里的 {url, type} 形态） */
function collectOutputFiles(outputs: Record<string, any> | null | undefined, files: DifyFilePayload[]) {
  if (!outputs) return
  const visit = (value: any) => {
    if (Array.isArray(value)) {
      value.forEach(visit)
    } else if (isFileObject(value)) {
      files.push({ url: value.url, type: value.type })
    }
  }
  Object.values(outputs).forEach(visit)
}

/** 从 workflow outputs 提取文本：单值字符串直接用，否则拼接全部字符串值 */
function extractTextOutputs(outputs: Record<string, any> | null | undefined): string {
  if (!outputs) return ''
  const values = Object.values(outputs)
  if (values.length === 1 && typeof values[0] === 'string') return values[0]
  return values.filter((v): v is string => typeof v === 'string' && v.length > 0).join('\n')
}

/** workflow blocking 响应 → 统一回复形态（失败/中止状态抛 DifyApiError）；导出供冒烟测试直测 */
export function parseWorkflowResponse(response: WorkflowBlockingResponse): DifyReply {
  const data = response.data
  if (data.error) throw new DifyApiError(data.error, 200)
  if (data.status && !SUCCESS_STATUSES.includes(data.status)) {
    throw new DifyApiError(`workflow ${data.status}`, 200)
  }
  const files: DifyFilePayload[] = []
  collectOutputFiles(data.outputs, files)
  return { text: extractTextOutputs(data.outputs), files }
}

/** 一次调用的上下文产物 */
interface RequestContext {
  bindingKey: string
  difyUser: string
  inputs: Record<string, any>
  uploadedFiles: DifyInputFileObject[]
}

export class RequestRunner {
  constructor(
    private ctx: Context,
    private config: Config,
    private conversationStore: ConversationStore,
    private history: MessageHistory,
    /** 配置的应用表（name → 凭据） */
    private apps: Map<string, AppConfigEntry>,
    /** 启动探测结果（name → Dify mode），由 index 在 ready 后填充 */
    private appTypes: Map<string, string>
  ) {}

  /** 应用类型：schema 显式指定优先，auto 时用探测结果（未探测到回退 chat） */
  private appTypeOf(app: AppConfigEntry): string {
    return app.appType !== 'auto' ? app.appType : this.appTypes.get(app.name) ?? FALLBACK_APP_TYPE
  }

  async run(fireCtx: FireContext): Promise<void> {
    const { rule } = fireCtx
    const app = this.apps.get(rule.app)
    if (!app) {
      this.ctx.logger.warn('规则 %s 引用的应用 %s 未在配置中定义', rule.name, rule.app)
      return
    }
    const client = createDifyClient(this.ctx, app, this.config.requestTimeout)
    if (!client) return

    const requestCtx: RequestContext = {
      bindingKey: this.conversationStore.computeBindingKey(app.appId || app.name, rule, fireCtx),
      difyUser: this.conversationStore.computeDifyUser(rule, fireCtx),
      inputs: resolveVariables(rule, fireCtx, this.history),
      uploadedFiles: []
    }

    // 文件上传管线：消息触发时提取消息中的文件并上传，附加到请求体。
    // 注意：workflow 的「文件型输入变量」（inputs 内嵌文件对象）不在本管线范围内，
    // 顶层 files 已覆盖视觉模型组合输入的主场景。
    if (this.config.uploadFiles !== false && fireCtx.session) {
      requestCtx.uploadedFiles = await uploadMessageFiles(this.ctx, client, fireCtx.session, requestCtx.difyUser)
    }

    let reply: DifyReply
    try {
      reply = await this.dispatch(app, client, fireCtx, requestCtx)
    } catch (error) {
      this.ctx.logger.warn('规则 %s 请求失败：%s', rule.name, error)
      if (this.config.sendErrors && fireCtx.session) {
        await fireCtx.session.send(`Dify 请求失败：${errorMessage(error)}`).catch(() => {})
      }
      return
    }

    if (!reply.text && !reply.files.length) {
      this.ctx.logger.warn('规则 %s 的请求未返回任何内容', rule.name)
      return
    }

    const messages = renderReply({
      text: reply.text,
      files: reply.files,
      quoteMessageId: fireCtx.session?.messageId,
      config: this.config
    })
    await this.deliver(fireCtx, messages)
  }

  /** 按应用类型分流：workflow/completion 无会话，chat 系续接 conversation_id */
  private async dispatch(
    app: AppConfigEntry,
    client: DifyClient,
    fireCtx: FireContext,
    requestCtx: RequestContext
  ): Promise<DifyReply> {
    const base = {
      inputs: requestCtx.inputs,
      response_mode: 'blocking' as const,
      user: requestCtx.difyUser,
      ...(requestCtx.uploadedFiles.length ? { files: requestCtx.uploadedFiles } : {})
    }
    const appType = this.appTypeOf(app)
    if (appType === 'workflow') {
      return parseWorkflowResponse(await client.runWorkflow(base))
    }
    if (appType === 'completion') {
      const response = await client.runCompletion(base)
      return { text: response.answer, files: [] }
    }
    // chat / agent-chat / advanced-chat，以及未探测类型的默认路径
    const conversationId = await this.conversationStore.getConversationId(requestCtx.bindingKey)
    const response = await client.runChat({
      ...base,
      query: fireCtx.queryText || FALLBACK_QUERY,
      // 空串表示新建会话
      conversation_id: conversationId ?? '',
      auto_generate_name: true
    })
    if (response.conversation_id && response.conversation_id !== conversationId) {
      await this.conversationStore
        .saveConversationId(requestCtx.bindingKey, response.conversation_id)
        .catch((error) => this.ctx.logger.warn('会话回写失败：%s', error))
    }
    return { text: response.answer, files: [] }
  }

  private async deliver(fireCtx: FireContext, messages: h[][]) {
    if (!messages.length) return
    if (fireCtx.session) {
      for (const message of messages) {
        await fireCtx.session.send(message).catch((error) => this.ctx.logger.warn(error))
      }
      return
    }
    // 定时摘要触发无 session：挑选该平台上任一在线 bot 发送到窗口收集的频道
    const bot = Object.values(this.ctx.bots).find((b) => b.platform === fireCtx.platform)
    if (!bot) {
      this.ctx.logger.warn('平台 %s 上没有可用 bot，无法发送主动消息', fireCtx.platform)
      return
    }
    for (const message of messages) {
      await bot.sendMessage(fireCtx.channelId, message).catch((error) => this.ctx.logger.warn(error))
    }
  }
}
