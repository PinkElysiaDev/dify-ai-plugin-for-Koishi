import { DifyApiError } from '../api/types'

/** 统一把 unknown 错误转为可读消息（Error.message 优先，空消息回退 String 形态） */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message || String(error)
}

/** 调试日志用的错误详情：Dify 报错展开状态码与错误码，附带调用栈 */
export function errorDetail(error: unknown): string {
  if (error instanceof DifyApiError) {
    return `status=${error.status}${error.code ? ` code=${error.code}` : ''} ${error.stack ?? error.message}`
  }
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}
