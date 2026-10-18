import { Context, Next, Session } from 'koishi'
import { CooldownSetting, DensityCondition, DifyRule, FireContext } from '../types'
import {
  MessageHistory,
  buildHistoryEntry,
  formatHistoryBrief,
  formatHistoryEntries,
  formatHistoryEntry,
  HistoryEntry
} from '../history'
import { RequestRunner } from '../requester/runner'
import { ConditionMatched, evaluateCondition, matchScope } from './conditions'
import { ChannelPool, DensityFire, MessagePool } from './pool'
import { registerPoolEvents } from './pool-events'
import { RuleScheduler } from './scheduler'
import {
  CooldownLane,
  densityLane,
  DENSITY_LANE_PREFIX,
  ExpiredCooldown,
  PendingMessage,
  TriggerCooldown
} from './cooldown'
import { channelKeyOf } from '../utils/keys'

/** 调度器 tick 间隔 */
const SCHEDULER_TICK_MS = 1_000

/** 非空行拼接（合并触发的统一格式行与精简行共用） */
const joinNonEmpty = (parts: string[]) => parts.filter(Boolean).join('\n')

/** 收集条目合集的图片 URL（仅真人消息——bot 自己发的图不回传 Dify；同图重复由上传入口去重） */
function collectImageUrls(entries: Array<HistoryEntry | null>): string[] {
  return entries.flatMap((entry) => (entry?.role === 'user' ? entry.imageUrls ?? [] : []))
}

/** 窗口触发（密度/定时到期）的三元组：统一格式 query、精简行 content、真人图片合集 */
function windowFieldsOf(entries: HistoryEntry[]) {
  return {
    queryText: formatHistoryEntries(entries),
    contentText: formatHistoryBrief(entries),
    imageUrls: collectImageUrls(entries)
  }
}

/** 消息会话的触发身份（无群概念的平台 guildId 回退频道） */
function sessionIdentityOf(session: Session) {
  return {
    platform: session.platform,
    selfId: session.selfId,
    channelId: session.channelId,
    guildId: session.guildId ?? session.channelId,
    userId: session.userId
  }
}

/** 池条目的触发身份（定时与密度到期等无 session 投递用） */
function poolIdentityOf(channel: ChannelPool) {
  return {
    platform: channel.platform,
    selfId: channel.selfId,
    channelId: channel.channelId,
    guildId: channel.guildId
  }
}

/**
 * 触发引擎：规则来自配置（normalizeConfig 已按优先级降序），
 * 配置改动由 cordis 重载插件整体生效，无需热重载接口。
 */
export class TriggerEngine {
  private scheduler: RuleScheduler
  private pool: MessagePool
  private cooldown: TriggerCooldown

  constructor(
    private ctx: Context,
    private runner: RequestRunner,
    private history: MessageHistory,
    private rules: DifyRule[],
    cooldown: CooldownSetting | null
  ) {
    this.scheduler = new RuleScheduler(ctx, (rule) => this.fireSchedule(rule))
    this.pool = new MessagePool()
    this.cooldown = new TriggerCooldown(cooldown)
  }

  start() {
    this.ctx.middleware((session, next) => this.handleMessage(session, next))
    // 秒级 tick 驱动定时触发与冷却到期扫描；cordis timer 随上下文自动清理
    this.ctx.setInterval(() => {
      this.scheduler.tick()
      this.tickCooldown()
    }, SCHEDULER_TICK_MS)
    // bot 自己发出的回复也入历史与消息池：历史变量双向可见，摘要/密度 query 里标注为机器人发言
    this.ctx.on('send', (session) => {
      const entry = session.channelId ? buildHistoryEntry(session, 'assistant') : null
      if (!entry) return
      const key = channelKeyOf(session.platform, session.channelId)
      this.history.recordEntry(key, entry)
      this.pool.record(session, entry)
    })
    // 群事件（戳一戳/入退群等）入池当上下文，不进历史变量
    registerPoolEvents(this.ctx, this.pool)
    this.scheduler.sync(this.rules)
    this.ctx.logger.info('已加载 %d 条启用规则', this.rules.length)
  }

  private handleMessage(session: Session, next: Next) {
    // 忽略其它 bot（含自己）的消息与无频道消息
    if (this.ctx.bots[session.uid] || !session.channelId) return next()
    const channelKey = channelKeyOf(session.platform, session.channelId)
    // 先同步收走本频道到期的冷却通道，再顺延与判定：消除「已到期但 tick 未收走」窗口里
    // beginCooldown 覆盖旧缓冲、密度通道被顺延复活的竞态。放在 entry 判定之前，
    // 纯引用等构造不出条目的消息同样先收走（quote 类条件仍可命中）。
    this.tickCooldown(channelKey)
    // 历史 / 消息池对所有过路消息生效，无论是否命中规则；entry 统一构造一次共用
    const entry = buildHistoryEntry(session)
    if (entry) {
      this.history.recordEntry(channelKey, entry)
      this.pool.record(session, entry)
      const now = session.timestamp ?? Date.now()
      // 密度冷却期即积攒期：消息照常入池，且全部过路消息顺延滑动窗口
      this.cooldown.extendDensityLanes(channelKey, now)
      // 冷却中的密度条件不参与判定，其余照常
      for (const fire of this.pool.checkDensity(this.rules, session, (rule, _condition, index) =>
        this.cooldown.isCooling(channelKey, rule.name, densityLane(index), now)
      )) {
        this.fireDensity(fire, session)
      }
    }
    // 命令优先：先让命令链处理，未被处理的消息再评估触发
    return next(async (nextMiddleware) => {
      // 命令链可能延迟判定，覆盖中间件执行期间到期的通道后再判定
      this.tickCooldown(channelKey)
      const matched = this.matchRule(session)
      if (!matched) return nextMiddleware()
      // 消息通道冷却中：缓存命中消息并顺延滑动窗口，到期合并为一次触发
      if (this.cooldown.isCooling(channelKey, matched.rule.name, 'message', Date.now())) {
        this.cooldown.bufferMessage(channelKey, matched.rule.name, {
          session,
          entry,
          contentText: matched.condition.contentText
        })
        this.cooldown.extend(channelKey, matched.rule.name, 'message', Date.now())
        return
      }
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

  /** 登记冷却（定时触发不调用；冷却关闭时零开销直退） */
  private beginCooldown(channelKey: string, ruleName: string, lane: CooldownLane) {
    this.cooldown.begin(channelKey, ruleName, lane, Date.now())
  }

  private fireMessage(rule: DifyRule, session: Session, condition: ConditionMatched, entry: HistoryEntry | null) {
    // 即时触发即消费：entry 与池内条目同引用，密度计数不再累计、摘要行尾注记已回复
    if (entry) entry.replied = true
    this.beginCooldown(channelKeyOf(session.platform, session.channelId), rule.name, 'message')
    this.run({
      session,
      ...sessionIdentityOf(session),
      triggerType: condition.type,
      rule,
      // query 为该条消息的统一格式单行；纯 @ / 纯引用等无文本消息 entry 为空，由请求器占位兜底
      queryText: entry ? formatHistoryEntry(entry) : '',
      contentText: condition.contentText
    })
  }

  private fireDensity(fire: DensityFire, session: Session) {
    // 密度只作触发依据：query 为取走的该频道全池消息（统一格式），content 用精简行
    this.beginCooldown(channelKeyOf(session.platform, session.channelId), fire.rule.name, densityLane(fire.conditionIndex))
    this.run({
      session,
      ...sessionIdentityOf(session),
      triggerType: 'frequency',
      rule: fire.rule,
      ...windowFieldsOf(fire.entries)
    })
  }

  /** 冷却到期：把缓冲内的触发消息合并为一次触发，session 取首条（供投递与文件上传） */
  private fireMerged(rule: DifyRule, buffer: PendingMessage[]) {
    // 合并触发即消费：缓冲条目与池内同引用，标记已回复
    for (const item of buffer) {
      if (item.entry) item.entry.replied = true
    }
    const first = buffer[0]
    const queryText = joinNonEmpty(buffer.map((item) => (item.entry ? formatHistoryEntry(item.entry) : '')))
    const contentText = joinNonEmpty(buffer.map((item) => item.contentText))
    this.beginCooldown(channelKeyOf(first.session.platform, first.session.channelId), rule.name, 'message')
    this.run({
      session: first.session,
      ...sessionIdentityOf(first.session),
      triggerType: 'merged',
      rule,
      queryText,
      contentText,
      // 补齐缓冲内非首条消息的图片（首条由 session 元素提取，重复由上传入口去重）
      imageUrls: collectImageUrls(buffer.map((item) => item.entry))
    })
  }

  /** 密度冷却到期复查达标：无当前消息，用池身份构造上下文（投递同定时路径） */
  private fireDensityExpiry(
    rule: DifyRule,
    condition: DensityCondition,
    conditionIndex: number,
    channel: ChannelPool,
    now: number
  ) {
    this.beginCooldown(channelKeyOf(channel.platform, channel.channelId), rule.name, densityLane(conditionIndex))
    // 取池内窗口中最后一条真人消息的作者作 userId，与即时密度触发（凑阈值消息的发送者）对齐，
    // 避免 per-user 规则在到期路径落到 channelId 伪用户、拆出第二段 Dify 会话
    const windowMs = condition.densityWindowSeconds * 1000
    let userId: string | undefined
    for (let i = channel.entries.length - 1; i >= 0; i--) {
      const item = channel.entries[i]
      if (item.role === 'user' && now - item.timestamp <= windowMs) {
        userId = item.userId
        break
      }
    }
    this.run({
      ...poolIdentityOf(channel),
      userId,
      triggerType: 'frequency',
      rule,
      ...windowFieldsOf(channel.entries),
      isDirect: channel.isDirect
    })
  }

  /**
   * 定时触发（消息摘要）：把消息池内该规则作用域有消息的每个频道各发一次请求（取走即清空全池）。
   * 频道身份取自池内最近一条消息；无消息的频道自然跳过。定时不受冷却影响。
   */
  private fireSchedule(rule: DifyRule) {
    for (const channel of this.pool.takeSchedule(rule)) {
      this.run({
        ...poolIdentityOf(channel),
        triggerType: 'cron',
        rule,
        ...windowFieldsOf(channel.entries),
        isDirect: channel.isDirect
      })
    }
  }

  /** 扫描冷却到期（带频道只扫该频道，消息路径用；每秒 interval 全量扫描）：消息通道合并触发，密度通道复查池 */
  private tickCooldown(channelKey?: string) {
    if (!this.cooldown.enabled) return
    const now = Date.now()
    for (const expired of this.cooldown.collectExpired(now, channelKey)) {
      this.onCooldownExpired(expired, now)
    }
  }

  private onCooldownExpired(expired: ExpiredCooldown, now: number) {
    // 配置重载即整体重建引擎，冷却态不会跨规则集存活；名字对不上属异常路径
    const rule = this.rules.find((item) => item.name === expired.ruleName)
    if (!rule) return
    if (expired.lane === 'message') {
      // 缓冲为空：状态已被取走，恢复常规触发
      if (expired.buffer.length) this.fireMerged(rule, expired.buffer)
      return
    }
    // 密度通道到期复查：达标才触发并重新冷却，未达标恢复常规判定
    const index = Number(expired.lane.slice(DENSITY_LANE_PREFIX.length))
    const condition = rule.conditions[index]
    if (condition?.type !== 'frequency') return
    const channel = this.pool.takeDensityChannel(rule, condition, expired.channelKey, now)
    if (channel) this.fireDensityExpiry(rule, condition, index, channel, now)
  }
}
