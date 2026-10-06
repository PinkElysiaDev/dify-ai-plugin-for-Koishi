import { Session } from 'koishi'
import { DifyRule } from '../types'
import { HistoryEntry } from '../history'
import { matchScope } from './conditions'
import { channelKeyOf } from '../utils/keys'

/** 一个频道的定时窗口缓冲：身份字段取自该频道最近一条被记录的消息 */
export interface ChannelDigest {
  platform: string
  channelId: string
  guildId?: string
  selfId: string
  entries: HistoryEntry[]
}

/**
 * 定时触发的消息窗口收集器。
 *
 * 定时规则是「消息摘要」模型：持续收集作用域内各频道的消息，
 * 到点（cron/间隔）把每个频道窗口内的消息合并为一次 Dify 请求，窗口空则跳过。
 * take() 取走即清空——窗口即「上次触发至今」；规则各自独立缓冲，互不干扰。
 */
export class MessageDigest {
  /** ruleName → channelKey → 窗口缓冲 */
  private windows = new Map<string, Map<string, ChannelDigest>>()

  /** 把一条消息记入所有 schedule 规则（作用域匹配）的窗口 */
  record(rules: DifyRule[], session: Session, entry: HistoryEntry) {
    for (const rule of rules) {
      if (!rule.conditions.some((condition) => condition.type === 'schedule')) continue
      if (!matchScope(rule.scope, session)) continue
      const key = channelKeyOf(session.platform, session.channelId)
      let channels = this.windows.get(rule.name)
      if (!channels) {
        channels = new Map()
        this.windows.set(rule.name, channels)
      }
      let digest = channels.get(key)
      if (!digest) {
        digest = {
          platform: session.platform,
          channelId: session.channelId,
          guildId: session.guildId,
          selfId: session.selfId,
          entries: []
        }
        channels.set(key, digest)
      }
      digest.entries.push(entry)
    }
  }

  /** 取走规则窗口内的全部非空频道缓冲（并清空该规则的窗口） */
  take(rule: DifyRule): ChannelDigest[] {
    const channels = this.windows.get(rule.name)
    this.windows.delete(rule.name)
    if (!channels) return []
    return [...channels.values()].filter((digest) => digest.entries.length > 0)
  }
}
