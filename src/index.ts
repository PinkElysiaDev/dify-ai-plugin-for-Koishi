import { Context } from 'koishi'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'
import { AppConfigEntry, Config, normalizeConfig } from './config'
import { createDifyClient } from './api/client'
import { MessageHistory } from './history'
import { TriggerEngine } from './trigger/engine'
import { RequestRunner } from './requester/runner'
import { ConversationStore } from './state/conversation'
import { defineTables } from './state/tables'
import { registerMiscCommands } from './commands/misc'

export const name = 'dify-ai'
export const inject = { required: ['database'] }

export { Config }

/** 应用类型探测的独立超时：探测是轻量 /info，不应沿用请求级长超时（Dify 不可达时拖住重载） */
const PROBE_TIMEOUT_MS = 10_000

export function apply(ctx: Context, config: Config) {
  const startedAt = Date.now()
  ctx.logger.info('apply 进入')
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('en-US', enUS)

  defineTables(ctx)

  // 全部配置来自 koishi schema：改动后 cordis 重载插件即生效
  const { apps, rules, cooldown } = normalizeConfig(config)
  /** 应用类型探测结果（appType 为 auto 的应用启动时填充） */
  const appTypes = new Map<string, string>()

  const history = new MessageHistory(config.historyLimit)
  const conversationStore = new ConversationStore(ctx, apps)
  const runner = new RequestRunner(ctx, config, conversationStore, history, apps, appTypes)
  const engine = new TriggerEngine(ctx, runner, history, rules, cooldown)

  ctx.on('ready', () => {
    // 先注册触发再后台探测：探测是网络请求（自建/代理下可达数秒），
    // 阻塞 start 会让重载窗口内消息触发完全失灵；探测完成前的请求按 chat 路径回退
    engine.start()
    ctx.logger.info('插件装配完成，耗时 %dms', Date.now() - startedAt)
    const probeStart = Date.now()
    void probeAppTypes(ctx, apps, appTypes).then(() => {
      ctx.logger.info('应用类型探测完成，耗时 %dms', Date.now() - probeStart)
    })
  })

  const admin = ctx.command('dify', { authority: 3 })
  registerMiscCommands(admin, conversationStore)
}

/** 对 appType=auto 的应用并发调 GET /info 探测类型（显式配置类型的应用不探测，无 auto 应用时整体跳过）；失败 warn 并回退 chat 路径 */
async function probeAppTypes(
  ctx: Context,
  apps: Map<string, AppConfigEntry>,
  appTypes: Map<string, string>
) {
  const autoApps = [...apps.values()].filter((app) => app.appType === 'auto')
  if (!autoApps.length) return
  await Promise.all(
    autoApps.map(async (app) => {
      const client = createDifyClient(ctx, app, PROBE_TIMEOUT_MS)
      if (!client) return
      try {
        const info = await client.getAppInfo()
        appTypes.set(app.name, info.mode)
        ctx.logger.info('应用 %s 类型探测：%s', app.name, info.mode)
      } catch (error) {
        ctx.logger.warn('应用 %s 类型探测失败（按 chat 处理）：%s', app.name, error)
      }
    })
  )
}
