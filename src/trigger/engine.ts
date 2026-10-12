import { Context, Next, Session } from 'koishi'
import { DifyRule, FireContext } from '../types'
import { MessageHistory, buildHistoryEntry, formatHistoryEntries, formatHistoryEntry, HistoryEntry } from '../history'
import { RequestRunner } from '../requester/runner'
import { ConditionMatched, evaluateCondition, matchScope } from './conditions'
import { MessagePool } from './pool'
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
  private pool: MessagePool

  constructor(
    private ctx: Context,
    private runner: RequestRunner,
    private history: MessageHistory,
    private rules: DifyRule[]
  ) {
    this.scheduler = new RuleScheduler(ctx, (rule) => this.fireSchedule(rule))
    this.pool = new MessagePool()
  }

  start() {
    this.ctx.middleware((session, next) => this.handleMessage(session, next))
    // 秒级 tick 驱动定时触发；cordis timer 随上下文自动清理
    this.ctx.setInterval(() => this.scheduler.tick(), SCHEDULER_TICK_MS)
    // bot 自己发出的回复也入历史与消息池：历史变量双向可见，摘要/密度 query 里标注为机器人发言
    this.ctx.on('send', (session) => {
      const entry = session.channelId ? buildHistoryEntry(session, 'assistant') : null
      if (!entry) return
      const key = channelKeyOf(session.platform, session.channelId)
      this.history.recordEntry(key, entry)
      this.pool.record(session, entry)
    })
    this.scheduler.sync(this.rules)
    this.ctx.logger.info('已加载 %d 条启用规则', this.rules.length)
  }

  private handleMessage(session: Session, next: Next) {
    // 忽略其它 bot（含自己）的消息
    if (this.ctx.bots[session.uid]) return next()
    if (!session.channelId) return next()
    // 历史 / 消息池对所有过路消息生效，无论是否命中规则；entry 统一构造一次共用
    const entry = buildHistoryEntry(session)
    if (entry) {
      this.history.recordEntry(channelKeyOf(session.platform, session.channelId), entry)
      this.pool.record(session, entry)
      for (const fire of this.pool.checkDensity(this.rules, session)) {
        this.fireDensity(fire.rule, session, fire.entries)
      }
    }
    // 命令优先：先让命令链处理，未被处理的消息再评估触发
    return next(async (nextMiddleware) => {
      const matched = this.matchRule(session)
      if (!matched) return nextMiddleware()
      // 已命中规则：异步执行，不阻塞中间件链，也不再向后传递
      this.fireMessage(matched.rule, session, matched.condition, entry)
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

  private fireMessage(rule: DifyRule, session: Session, condition: ConditionMatched, entry: HistoryEntry | null) {
    this.run({
      session,
      platform: session.platform,
      selfId: session.selfId,
      channelId: session.channelId,
      guildId: session.guildId ?? session.channelId,
      userId: session.userId,
      triggerType: condition.type,
      rule,
      // query 为该条消息的统一格式单行；纯 @ / 纯引用等无文本消息 entry 为空，由请求器占位兜底
      queryText: entry ? formatHistoryEntry(entry) : '',
      contentText: condition.queryText
    })
  }

  private fireDensity(rule: DifyRule, session: Session, entries: HistoryEntry[]) {
    // 密度只作触发依据：query 为取走的该频道全池消息
    const windowText = formatHistoryEntries(entries)
    this.run({
      session,
      platform: session.platform,
      selfId: session.selfId,
      channelId: session.channelId,
      guildId: session.guildId ?? session.channelId,
      userId: session.userId,
      triggerType: 'density',
      rule,
      queryText: windowText,
      contentText: windowText
    })
  }

  /**
   * 定时触发（消息摘要）：把消息池内该规则作用域有消息的每个频道各发一次请求（取走即清空全池）。
   * 频道身份取自池内最近一条消息；无消息的频道自然跳过。
   */
  private fireSchedule(rule: DifyRule) {
    for (const channel of this.pool.takeSchedule(rule)) {
      const windowText = formatHistoryEntries(channel.entries)
      this.run({
        platform: channel.platform,
        selfId: channel.selfId,
        channelId: channel.channelId,
        guildId: channel.guildId,
        triggerType: 'schedule',
        rule,
        queryText: windowText,
        contentText: windowText
      })
    }
  }
}
