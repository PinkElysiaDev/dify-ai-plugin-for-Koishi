import { Session } from 'koishi'
import { DifyRule } from '../types'
import { HistoryEntry } from '../history'
import { channelKeyOf } from '../utils/keys'

/**
 * 消息密度触发：按 (规则, 频道) 维护滑动窗口内的消息，
 * 窗口内条数达到阈值即回调触发，并把窗口内这些消息交给触发方作 query 上下文。
 * 触发后清空窗口，需重新积累即天然防连发。
 */
export class DensityTracker {
  private windows = new Map<string, HistoryEntry[]>()

  constructor(
    private onTrigger: (rule: DifyRule, session: Session, entries: HistoryEntry[]) => void
  ) {}

  /** 把一条消息计入所有 density 规则的窗口；达到阈值的窗口立即触发 */
  record(rules: DifyRule[], session: Session, entry: HistoryEntry) {
    for (const rule of rules) {
      for (const condition of rule.conditions) {
        if (condition.type !== 'density') continue
        const windowMs = condition.densityWindowSeconds * 1000
        const key = `${rule.name}|${channelKeyOf(session.platform, session.channelId)}`
        const entries = (this.windows.get(key) ?? []).filter((item) => entry.timestamp - item.timestamp <= windowMs)
        entries.push(entry)
        if (entries.length >= condition.densityCount) {
          this.windows.delete(key)
          this.onTrigger(rule, session, entries)
        } else {
          this.windows.set(key, entries)
        }
      }
    }
  }
}
