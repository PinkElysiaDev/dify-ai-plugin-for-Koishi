import { Context } from 'koishi'

export interface DifyConversationRow {
  /** 应用名 + 粒度 + 平台身份编码出的绑定键，唯一确定一条 Dify 会话 */
  bindingKey: string
  /** Dify 侧 conversation_id；workflow/completion 类应用恒为空 */
  difyConversationId: string
}

declare module 'koishi' {
  interface Tables {
    dify_conversation: DifyConversationRow
  }
}

/** 数据库只剩会话绑定一张表：应用与规则全部由 koishi schema 配置管理 */
function defineConversationTable(ctx: Context) {
  ctx.model.extend('dify_conversation', {
    bindingKey: 'string(255)',
    difyConversationId: { type: 'char', length: 64, nullable: true }
  }, { primary: 'bindingKey' })
}

export function defineTables(ctx: Context) {
  defineConversationTable(ctx)
}
