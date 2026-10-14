import { Session } from 'koishi'
import { DensityCondition, DifyRule } from '../types'
import { HistoryEntry } from '../history'
import { matchScope } from './conditions'
import { channelKeyOf } from '../utils/keys'

/** 每频道池容量上限：无规则触发时防止缓冲无限增长 */
const POOL_CAPACITY = 1024

/** 一个频道的缓冲池：密度与定时共用，谁先触发谁取走清空 */
export interface ChannelPool {
  platform: string
  channelId: string
  guildId?: string
  /** 定时投递凭据，跟随最近一条消息的 bot */
  selfId: string
  isDirect?: boolean
  entries: HistoryEntry[]
}

/** 按池身份与条目作者构造 matchScope 可判定的会话形状（matchScope 只读这几个字段） */
function scopeSessionOf(pool: ChannelPool, entry: HistoryEntry): Session {
  return {
    platform: pool.platform,
    selfId: pool.selfId,
    channelId: pool.channelId,
    guildId: pool.guildId,
    userId: entry.userId,
    isDirect: pool.isDirect,
  } as Session
}

export interface DensityFire {
  rule: DifyRule
  /** 命中条件在规则内的下标（密度冷却通道键） */
  conditionIndex: number
  /** 触发时取走的该频道全池消息（含 bot 行与时效外条目） */
  entries: HistoryEntry[]
}

/**
 * 频道消息池：密度与定时触发共用的缓冲层。
 * 密度只作触发依据（时效内真人条数达阈值），触发即取走全池；
 * 定时到点取走作用域内有消息的频道全池——两者天然互相清空、重新积累。
 */
export class MessagePool {
  private channels = new Map<string, ChannelPool>()

  /** 一条消息（含 bot 自己的发言）入池，全量记录不做规则过滤 */
  record(session: Session, entry: HistoryEntry) {
    const key = channelKeyOf(session.platform, session.channelId)
    let pool = this.channels.get(key)
    if (!pool) {
      pool = {
        platform: session.platform,
        channelId: session.channelId,
        guildId: session.guildId,
        selfId: session.selfId,
        isDirect: session.isDirect,
        entries: []
      }
      this.channels.set(key, pool)
    }
    pool.selfId = session.selfId
    pool.guildId = session.guildId
    pool.isDirect = session.isDirect
    pool.entries.push(entry)
    if (pool.entries.length > POOL_CAPACITY) {
      pool.entries.splice(0, pool.entries.length - POOL_CAPACITY)
    }
  }

  /** 时效内且通过规则作用域的真人条数（bot 行不推高密度防自激励；已即时回复过的消息不重复计数防双触发） */
  private countQualified(pool: ChannelPool, rule: DifyRule, condition: DensityCondition, now: number): number {
    const windowMs = condition.densityWindowSeconds * 1000
    return pool.entries.filter(
      (item) =>
        item.role === 'user' &&
        !item.replied &&
        now - item.timestamp <= windowMs &&
        matchScope(rule.scope, scopeSessionOf(pool, item))
    ).length
  }

  /**
   * 新消息入池后的密度评估：时效内（相对触发消息）且通过规则作用域的真人条数达到阈值。
   * 触发即取走并清空该频道全池（bot 行不推高密度，防自激励）；池清空后其余规则无从触发。
   * skip 返回 true 的条件（冷却中的密度条件）不参与判定。
   */
  checkDensity(
    rules: DifyRule[],
    session: Session,
    skip?: (rule: DifyRule, condition: DensityCondition, index: number) => boolean
  ): DensityFire[] {
    const key = channelKeyOf(session.platform, session.channelId)
    const pool = this.channels.get(key)
    if (!pool) return []
    const now = session.timestamp ?? Date.now()
    for (const rule of rules) {
      for (let index = 0; index < rule.conditions.length; index++) {
        const condition = rule.conditions[index]
        if (condition.type !== 'density') continue
        if (skip?.(rule, condition, index)) continue
        if (this.countQualified(pool, rule, condition, now) >= condition.densityCount) {
          this.channels.delete(key)
          return [{ rule, conditionIndex: index, entries: pool.entries }]
        }
      }
    }
    return []
  }

  /** 给池内已有条目标注已撤回（按消息 ID 定位，找不到忽略——不新建条目） */
  markDeleted(channelKey: string, messageId: string) {
    const pool = this.channels.get(channelKey)
    if (!pool) return
    for (let i = pool.entries.length - 1; i >= 0; i--) {
      if (pool.entries[i].messageId === messageId) {
        pool.entries[i].deleted = true
        return
      }
    }
  }

  /** 冷却到期复查：按条件参数统计该频道池（now 为复查时刻），达标即取走整池，未达标返回 null */
  takeDensityChannel(
    rule: DifyRule,
    condition: DensityCondition,
    channelKey: string,
    now: number
  ): ChannelPool | null {
    const pool = this.channels.get(channelKey)
    if (!pool) return null
    if (this.countQualified(pool, rule, condition, now) < condition.densityCount) return null
    this.channels.delete(channelKey)
    return pool
  }

  /** 定时到点：取走该规则作用域内有消息的所有频道（整池清空，含未过作用域的条目） */
  takeSchedule(rule: DifyRule): ChannelPool[] {
    const taken: ChannelPool[] = []
    for (const [key, pool] of this.channels) {
      const matched = pool.entries.some((entry) => matchScope(rule.scope, scopeSessionOf(pool, entry)))
      if (!matched) continue
      taken.push(pool)
      this.channels.delete(key)
    }
    return taken
  }
}
