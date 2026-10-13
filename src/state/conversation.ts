import { Context } from 'koishi'
import { createDifyClient } from '../api/client'
import { AppConfigEntry } from '../config'
import { DifyRule, FireContext } from '../types'

/** 会话状态机实际使用的绑定维度（私聊恒为 user 维，与规则配置无关） */
type ScopeDimension = 'user' | 'guild' | 'channel' | 'global'

/**
 * 会话状态机：把 koishi 侧 (应用, 平台, bot, 群/用户) 与
 * Dify 侧的 conversation_id 绑定并持久化。
 * 绑定维度是**应用**而非规则——指向同一应用、同一会话的多条规则共享同一段 Dify 对话。
 */
export class ConversationStore {
  constructor(
    private ctx: Context,
    /** 配置的应用表（重置时按应用名反查凭据） */
    private apps: Map<string, AppConfigEntry>
  ) {}

  /** 粒度归一：bindingKey 与 difyUser 共用，保证两者始终对齐 */
  private resolveScopeDimension(rule: DifyRule, fireCtx: FireContext): ScopeDimension {
    if (this.isDirectOf(fireCtx) || rule.conversationScope === 'per-user') return 'user'
    switch (rule.conversationScope) {
      case 'global':
        return 'global'
      case 'per-channel':
        return 'channel'
      default:
        return 'guild'
    }
  }

  /** 私聊判定：有 session 读 session，无 session 的主动触发读池透传的标记 */
  private isDirectOf(fireCtx: FireContext): boolean {
    return fireCtx.session?.isDirect ?? fireCtx.isDirect ?? false
  }

  /** bindingKey = 应用 ID + 粒度 + 平台身份 */
  computeBindingKey(appId: string, rule: DifyRule, fireCtx: FireContext): string {
    const base = `${appId}:${fireCtx.platform}:${fireCtx.selfId}`
    switch (this.resolveScopeDimension(rule, fireCtx)) {
      // 群内按「群+用户」区分；私聊用 private 段占位
      case 'user':
        return this.isDirectOf(fireCtx)
          ? `${base}:private:${fireCtx.userId ?? fireCtx.channelId}`
          : `${base}:user:${fireCtx.guildId ?? fireCtx.channelId}:${fireCtx.userId ?? fireCtx.channelId}`
      case 'guild':
        return `${base}:guild:${fireCtx.guildId ?? fireCtx.channelId}`
      case 'channel':
        return `${base}:channel:${fireCtx.channelId}`
      case 'global':
        return `${appId}:global`
    }
  }

  /**
   * Dify 侧终端用户标识（不再入库，按 bindingKey 字段推导）。
   * 会话/文件等操作都校验 user 一致性，必须与 bindingKey 粒度对齐；
   * 私聊的群段用 private 占位，不省略。
   */
  computeDifyUser(rule: DifyRule, fireCtx: FireContext): string {
    switch (this.resolveScopeDimension(rule, fireCtx)) {
      case 'user':
        return this.isDirectOf(fireCtx)
          ? `koishi:${fireCtx.platform}:private:${fireCtx.userId ?? fireCtx.channelId}`
          : `koishi:${fireCtx.platform}:${fireCtx.guildId ?? fireCtx.channelId}:${fireCtx.userId ?? fireCtx.channelId}`
      case 'guild':
        return `koishi:${fireCtx.platform}:${fireCtx.guildId ?? fireCtx.channelId}`
      case 'channel':
        return `koishi:${fireCtx.platform}:${fireCtx.channelId}`
      case 'global':
        return 'koishi'
    }
  }

  async getConversationId(bindingKey: string): Promise<string | undefined> {
    const [row] = await this.ctx.database.get('dify_conversation', { bindingKey })
    return row?.difyConversationId ?? undefined
  }

  async saveConversationId(bindingKey: string, difyConversationId: string) {
    await this.ctx.database.upsert('dify_conversation', [{ bindingKey, difyConversationId }])
  }

  /** 解析 bindingKey 的构成（重置时反查应用凭据与 difyUser 用） */
  private parseBindingKey(bindingKey: string): {
    /** 首段是应用 ID（配置留空时即应用名） */
    appId: string
    platform: string
    /** user / private / guild / channel；global 段只有应用 ID，无平台与粒度段 */
    scope?: string
    /** scope 之后的 id 片段 */
    ids: string[]
  } {
    const [appId, platform, , scope, ...ids] = bindingKey.split(':')
    return { appId, platform, scope, ids }
  }

  /** 由 bindingKey 还原删除 Dify 会话所需的 difyUser（与 computeDifyUser 对齐） */
  private difyUserOfBindingKey(bindingKey: string): string {
    const { platform, scope, ids } = this.parseBindingKey(bindingKey)
    switch (scope) {
      case 'global':
        return 'koishi'
      case 'private':
        return `koishi:${platform}:private:${ids.join(':')}`
      case 'guild':
      case 'channel':
      case 'user':
        return `koishi:${platform}:${ids.join(':')}`
      default:
        return `koishi:${platform}`
    }
  }

  /**
   * 重置匹配的绑定：本地删行 + 尽力删除 Dify 侧会话（失败仅记录）。
   * 表已无 guildKey 列，按频道匹配时全表读回后解析 bindingKey 过滤（行数量级很小）。
   * 覆盖 guild / user（群内）/ channel 段与私聊执行时的 private 段；
   * global 段跨频道，不随单频道重置。
   */
  async resetWhere(filter: {
    bindingKey?: string
    guildKey?: string
    channelKey?: string
    isDirect?: boolean
    userId?: string
  }): Promise<number> {
    const rows = await this.ctx.database.get('dify_conversation', {})
    // 键内 id 片段可能内嵌冒号（私聊频道形如 private:12345），用首冒号切分而非 split
    const splitKey = (key: string): [string, string] => {
      const separator = key.indexOf(':')
      return separator < 0 ? [key, ''] : [key.slice(0, separator), key.slice(separator + 1)]
    }
    const [guildPlatform, guildId] = splitKey(filter.guildKey ?? '')
    const [channelPlatform, channelId] = splitKey(filter.channelKey ?? '')
    const matched = rows.filter((row) => {
      if (filter.bindingKey) return row.bindingKey === filter.bindingKey
      const { platform, scope, ids } = this.parseBindingKey(row.bindingKey)
      if (platform !== guildPlatform) return false
      if (scope === 'guild') return ids[0] === guildId
      if (scope === 'user') return ids.length === 2 ? ids[0] === guildId : false
      if (scope === 'channel') return platform === channelPlatform && ids[0] === channelId
      if (scope === 'private') return filter.isDirect === true && ids[0] === filter.userId
      // global 段跨频道，不随单频道重置
      return false
    })
    let reset = 0
    for (const row of matched) {
      if (row.difyConversationId) {
        const { appId } = this.parseBindingKey(row.bindingKey)
        // 首段可能是应用 ID 或应用名（appId 留空回退名），两者都查
        const app = this.apps.get(appId) ?? this.findByAppId(appId)
        const client = app && createDifyClient(this.ctx, app)
        if (client) {
          await client
            .deleteConversation(row.difyConversationId, this.difyUserOfBindingKey(row.bindingKey))
            .catch((error) => this.ctx.logger.warn('删除 Dify 会话失败：%s', error))
        }
      }
      await this.ctx.database.remove('dify_conversation', { bindingKey: row.bindingKey })
      reset++
    }
    return reset
  }

  /** 按应用 ID（apps 配置的 appId 字段）反查应用 */
  private findByAppId(appId: string): AppConfigEntry | undefined {
    for (const app of this.apps.values()) {
      if (app.appId && app.appId === appId) return app
    }
    return undefined
  }
}
