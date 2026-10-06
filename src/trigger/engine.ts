import { Context, Next, Session } from 'koishi'
import { DifyRule, FireContext } from '../types'
import { MessageHistory, buildHistoryEntry, formatHistoryEntries, HistoryEntry } from '../history'
import { RequestRunner } from '../requester/runner'
import { ConditionMatched, evaluateCondition, matchScope } from './conditions'
import { DensityTracker } from './density'
import { MessageDigest } from './digest'
import { RuleScheduler } from './scheduler'
import { channelKeyOf } from '../utils/keys'

/** 调度器 tick 间隔 */
const SCHEDULER_TICK_MS = 1_000

/**
 * 触发引擎：规则来自配置（normalizeConfig 已按优先级降序），
 * 配置改动由 cordis 重载插件整体生效，无需热重载接口。
 */
export class TriggerEngine {
  private scheduler: RuleScheduler
  private density: DensityTracker
  private digest: MessageDigest

  constructor(
    private ctx: Context,
    private runner: RequestRunner,
    private history: MessageHistory,
    private rules: DifyRule[]
  ) {
    this.scheduler = new RuleScheduler(ctx, (rule) => this.fireSchedule(rule))
    this.density = new DensityTracker((rule, session, entries) => this.fireDensity(rule, session, entries))
    this.digest = new MessageDigest()
  }

  start() {
    this.ctx.middleware((session, next) => this.handleMessage(session, next))
    // 秒级 tick 驱动定时触发；cordis timer 随上下文自动清理
    this.ctx.setInterval(() => this.scheduler.tick(), SCHEDULER_TICK_MS)
    // bot 自己发出的回复也记入历史，保证历史变量双向可见
    this.ctx.on('send', (session) => {
      const entry = session.channelId ? buildHistoryEntry(session, 'assistant') : null
      if (entry) this.history.recordEntry(channelKeyOf(session.platform, session.channelId), entry)
    })
    this.scheduler.sync(this.rules)
    this.ctx.logger.info('已加载 %d 条启用规则', this.rules.length)
  }

  private handleMessage(session: Session, next: Next) {
    // 忽略其它 bot（含自己）的消息
    if (this.ctx.bots[session.uid]) return next()
    if (!session.channelId) return next()
    // 历史 / 密度 / 定时窗口对所有过路消息生效，无论是否命中规则；entry 统一构造一次三家共用
    const entry = buildHistoryEntry(session)
    if (entry) {
      this.history.recordEntry(channelKeyOf(session.platform, session.channelId), entry)
      this.density.record(this.rules, session, entry)
      this.digest.record(this.rules, session, entry)
    }
    // 命令优先：先让命令链处理，未被处理的消息再评估触发
    return next(async (nextMiddleware) => {
      const matched = this.matchRule(session)
      if (!matched) return nextMiddleware()
      // 已命中规则：异步执行，不阻塞中间件链，也不再向后传递
      this.fireMessage(matched.rule, session, matched.condition)
    })
  }

  private matchRule(session: Session): { rule: DifyRule; condition: ConditionMatched } | null {
    for (const rule of this.rules) {
      if (!rule.conditions.length || !rule.app) continue
      if (!matchScope(rule.scope, session)) continue
      for (const condition of rule.conditions) {
        const result = evaluateCondition(condition, session)
        if (result) return { rule, condition: result }
      }
    }
    return null
  }

  /** 异步执行一次请求；错误由请求器与这里的兜底记录 */
  private run(fireCtx: FireContext) {
    void this.runner.run(fireCtx).catch((error) => this.ctx.logger.warn(error))
  }

  private fireMessage(rule: DifyRule, session: Session, condition: ConditionMatched) {
    this.run({
      session,
      platform: session.platform,
      selfId: session.selfId,
      channelId: session.channelId,
      guildId: session.guildId ?? session.channelId,
      userId: session.userId,
      triggerType: condition.type,
      rule,
      queryText: condition.queryText
    })
  }

  private fireDensity(rule: DifyRule, session: Session, entries: HistoryEntry[]) {
    // 密度触发的 query 即窗口内这些消息的统一格式拼接
    this.run({
      session,
      platform: session.platform,
      selfId: session.selfId,
      channelId: session.channelId,
      guildId: session.guildId ?? session.channelId,
      userId: session.userId,
      triggerType: 'density',
      rule,
      queryText: formatHistoryEntries(entries)
    })
  }

  /**
   * 定时触发（消息摘要）：把窗口内有消息的每个频道各发一次请求。
   * 频道身份取自窗口缓冲里记录的真实消息；窗口空（无消息）自然跳过。
   */
  private fireSchedule(rule: DifyRule) {
    for (const channel of this.digest.take(rule)) {
      this.run({
        platform: channel.platform,
        selfId: channel.selfId,
        channelId: channel.channelId,
        guildId: channel.guildId,
        triggerType: 'schedule',
        rule,
        queryText: channel.entries.map((entry) => `${entry.username}: ${entry.content}`).join('\n')
      })
    }
  }
}
