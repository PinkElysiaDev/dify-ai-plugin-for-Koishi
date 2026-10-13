import { Context } from 'koishi'
import { CronExpressionParser } from 'cron-parser'
import { DifyRule, ScheduleCondition } from '../types'

interface ScheduleEntry {
  rule: DifyRule
  nextRunAt: number
}

const MS_PER_MINUTE = 60_000

/**
 * 定时触发调度器：秒级 tick，到点回调 fire(rule)。
 * 规则本身是消息摘要模型——发往哪些频道由 engine 从消息窗口决定，这里只管计时。
 * 不做错过的补跑：到点即触发一次，然后从当前时刻重算下次运行。
 */
export class RuleScheduler {
  private entries: ScheduleEntry[] = []

  constructor(
    private ctx: Context,
    private fire: (rule: DifyRule) => void
  ) {}

  sync(rules: DifyRule[]) {
    // 插件整体重载模型下 sync 只在启动时调用一次，直接全量计算
    this.entries = rules
      .map((rule) => ({ rule, nextRunAt: this.computeNextRun(rule) }))
      .filter((entry): entry is ScheduleEntry => entry.nextRunAt != null)
  }

  tick() {
    const now = Date.now()
    const survivors: ScheduleEntry[] = []
    for (const entry of this.entries) {
      if (entry.nextRunAt > now) {
        survivors.push(entry)
        continue
      }
      try {
        this.fire(entry.rule)
      } catch (error) {
        this.ctx.logger.warn('定时规则 %s 触发失败：%s', entry.rule.name, error)
      }
      // 规则条件被改掉 schedule 后不再入列，而不是永驻数组
      const next = this.computeNextRun(entry.rule)
      if (next != null) survivors.push({ rule: entry.rule, nextRunAt: next })
    }
    this.entries = survivors
  }

  /** 单个 schedule 条件的下次触发时刻（cron 或固定间隔）；无效 cron 记 warn 跳过 */
  private nextRunOf(condition: ScheduleCondition, now: number): number | null {
    if (condition.cron) {
      try {
        return CronExpressionParser.parse(condition.cron, { currentDate: new Date() })
          .next()
          .getTime()
      } catch (error) {
        this.ctx.logger.warn('cron 表达式无效（%s），已跳过：%s', condition.cron, error)
        return null
      }
    }
    if (condition.intervalMinutes && condition.intervalMinutes > 0) {
      return now + condition.intervalMinutes * MS_PER_MINUTE
    }
    return null
  }

  /** 计算规则下一次触发时刻；无 schedule 条件返回 null */
  private computeNextRun(rule: DifyRule): number | null {
    const now = Date.now()
    let next: number | null = null
    for (const condition of rule.conditions) {
      if (condition.type !== 'schedule') continue
      const candidate = this.nextRunOf(condition, now)
      if (candidate != null && (next == null || candidate < next)) next = candidate
    }
    return next
  }
}
