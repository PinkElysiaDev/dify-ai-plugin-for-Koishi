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

export function apply(ctx: Context, config: Config) {
  ctx.i18n.define('zh-CN', zhCN)
  ctx.i18n.define('en-US', enUS)

  defineTables(ctx)

  // 全部配置来自 koishi schema：改动后 cordis 重载插件即生效
  const { apps, rules } = normalizeConfig(config)
  /** 应用类型探测结果（appType 为 auto 的应用启动时填充） */
  const appTypes = new Map<string, string>()

  const history = new MessageHistory(config.historyLimit)
  const conversationStore = new ConversationStore(ctx, apps)
  const runner = new RequestRunner(ctx, config, conversationStore, history, apps, appTypes)
  const engine = new TriggerEngine(ctx, runner, history, rules)

  ctx.on('ready', async () => {
    await probeAppTypes(ctx, config, apps, appTypes)
    engine.start()
  })

  const admin = ctx.command('dify', { authority: 3 })
  registerMiscCommands(admin, conversationStore)
}

/** 对 appType=auto 的应用并发调 GET /info 探测类型；失败 warn 并回退 chat 路径 */
async function probeAppTypes(
  ctx: Context,
  config: Config,
  apps: Map<string, AppConfigEntry>,
  appTypes: Map<string, string>
) {
  await Promise.all(
    [...apps.values()]
      .filter((app) => app.appType === 'auto')
      .map(async (app) => {
        const client = createDifyClient(ctx, app, config.requestTimeout)
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
