/** 统一把 unknown 错误转为可读消息（Error.message 优先，空消息回退 String 形态） */
export function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : ''
  return message || String(error)
}
