import { Context } from 'koishi'

export interface DifyConversationRow {
  /** 应用名 + 粒度 + 平台身份编码出的绑定键，唯一确定一条 Dify 会话 */
  bindingKey: string
  /** Dify 侧 conversation_id；workflow/completion 类应用恒为空 */
  difyConversationId: string
}

/** 应用类型探测的持久化缓存：重载后先读缓存分流，后台探测刷新 */
export interface DifyAppProbeRow {
  name: string
  mode: string
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    dify_conversation: DifyConversationRow
    dify_app_probe: DifyAppProbeRow
  }
}

/** 数据库两张表：会话绑定 + 应用类型探测缓存；应用与规则全部由 koishi schema 配置管理 */
function defineConversationTable(ctx: Context) {
  ctx.model.extend('dify_conversation', {
    bindingKey: 'string(255)',
    difyConversationId: { type: 'char', length: 64, nullable: true }
  }, { primary: 'bindingKey' })
}

function defineProbeTable(ctx: Context) {
  ctx.model.extend('dify_app_probe', {
    name: 'string(255)',
    mode: 'string(32)',
    updatedAt: 'timestamp'
  }, { primary: 'name' })
}

export function defineTables(ctx: Context) {
  defineConversationTable(ctx)
  defineProbeTable(ctx)
}
