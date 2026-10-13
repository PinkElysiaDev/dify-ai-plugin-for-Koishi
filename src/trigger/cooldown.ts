import { Session } from 'koishi'
import { CooldownSetting } from '../types'
import { HistoryEntry } from '../history'

/** 合并缓冲容量上限：防滑动窗口上限期间无限积压，超出丢最旧 */
const BUFFER_CAPACITY = 1024

/** 冷却期内缓存的一条触发消息（entry 供统一格式渲染，纯 @ 等无文本消息为空） */
export interface PendingMessage {
  session: Session
  entry: HistoryEntry | null
  /** 该条消息命中条件时剥离出的文本（contentText 用） */
  contentText: string
}

/** 冷却通道：message = 规则内全部消息类条件共享；density:N = 第 N 个密度条件独立 */
export type CooldownLane = 'message' | `density:${number}`

/** 密度通道名的下标前缀 */
export const DENSITY_LANE_PREFIX = 'density:'

/** 密度条件的通道名 */
export function densityLane(index: number): CooldownLane {
  return `${DENSITY_LANE_PREFIX}${index}`
}

/** 一个冷却通道的运行态 */
interface LaneCooldown {
  /** 本次冷却的触发时刻（滑动窗口上限的锚点） */
  fireAt: number
  deadline: number
  /** 消息通道的合并缓冲；密度通道不用 */
  buffer: PendingMessage[]
}

/** 到期扫描交出的通道产物 */
export interface ExpiredCooldown {
  channelKey: string
  ruleName: string
  lane: CooldownLane
  buffer: PendingMessage[]
}

/** 内层 Map 的键：规则名 + 通道 */
function laneKeyOf(ruleName: string, lane: CooldownLane): string {
  return `${ruleName}\n${lane}`
}

/**
 * 触发后冷却：从触发发起时刻计时（请求耗时计入冷却）。
 * 消息通道冷却期内命中消息进缓冲并顺延滑动窗口，到期合并为一次触发；
 * 密度通道冷却期即积攒期（池照常记录），全部过路消息顺延，到期复查达标才触发。
 * 定时触发不参与冷却。配置关闭时所有方法零开销直退。
 */
export class TriggerCooldown {
  /** channelKey → (规则名+通道 → 冷却态) */
  private channels = new Map<string, Map<string, LaneCooldown>>()

  constructor(private setting: CooldownSetting | null) {}

  get enabled(): boolean {
    return this.setting != null
  }

  /** 触发发起时登记冷却 */
  begin(channelKey: string, ruleName: string, lane: CooldownLane, now: number) {
    if (!this.setting) return
    const ms = this.setting.mode === 'fixed' ? this.setting.ms : this.setting.minMs
    this.lanesOf(channelKey).set(laneKeyOf(ruleName, lane), {
      fireAt: now,
      deadline: now + ms,
      buffer: []
    })
  }

  isCooling(channelKey: string, ruleName: string, lane: CooldownLane, now: number): boolean {
    // 只读查询不创建条目：冷却关闭时不能给每个频道留下永不清理的空 Map
    const state = this.channels.get(channelKey)?.get(laneKeyOf(ruleName, lane))
    return state != null && now < state.deadline
  }

  /** 滑动窗口顺延：截止推到「now + 最小窗口」，不超过「触发时刻 + 最大窗口」 */
  private slide(state: LaneCooldown, setting: { minMs: number; maxMs: number }, now: number) {
    state.deadline = Math.min(
      Math.max(state.deadline, now + setting.minMs),
      state.fireAt + setting.maxMs
    )
  }

  /** 滑动窗口顺延：已到期的通道不复活 */
  extend(channelKey: string, ruleName: string, lane: CooldownLane, now: number) {
    const setting = this.setting
    if (setting?.mode !== 'sliding') return
    const state = this.channels.get(channelKey)?.get(laneKeyOf(ruleName, lane))
    if (!state || now >= state.deadline) return
    this.slide(state, setting, now)
  }

  /** 该频道所有密度通道由一条过路消息顺延（密度冷却期内的消息积攒驱动窗口滑动）；已到期的不复活 */
  extendDensityLanes(channelKey: string, now: number) {
    const setting = this.setting
    if (setting?.mode !== 'sliding') return
    const lanes = this.channels.get(channelKey)
    if (!lanes) return
    for (const [key, state] of lanes) {
      if (!key.includes('\ndensity:') || now >= state.deadline) continue
      this.slide(state, setting, now)
    }
  }

  /** 冷却期内缓存一条命中消息（仅消息通道） */
  bufferMessage(channelKey: string, ruleName: string, message: PendingMessage) {
    const state = this.lanesOf(channelKey).get(laneKeyOf(ruleName, 'message'))
    if (!state) return
    state.buffer.push(message)
    if (state.buffer.length > BUFFER_CAPACITY) {
      state.buffer.splice(0, state.buffer.length - BUFFER_CAPACITY)
    }
  }

  /** 到期扫描：取走到期通道（连缓冲一并交出），由调用方决定是否重新登记；限定频道时只扫该频道 */
  collectExpired(now: number, channelKey?: string): ExpiredCooldown[] {
    const expired: ExpiredCooldown[] = []
    const targets = channelKey ? [[channelKey, this.channels.get(channelKey)] as const] : this.channels
    for (const [key, lanes] of targets) {
      if (!lanes) continue
      for (const [laneKey, state] of lanes) {
        if (now < state.deadline) continue
        const separator = laneKey.indexOf('\n')
        lanes.delete(laneKey)
        expired.push({
          channelKey: key,
          ruleName: laneKey.slice(0, separator),
          lane: laneKey.slice(separator + 1) as CooldownLane,
          buffer: state.buffer
        })
      }
      if (!lanes.size) this.channels.delete(key)
    }
    return expired
  }

  private lanesOf(channelKey: string): Map<string, LaneCooldown> {
    let lanes = this.channels.get(channelKey)
    if (!lanes) {
      lanes = new Map()
      this.channels.set(channelKey, lanes)
    }
    return lanes
  }
}
