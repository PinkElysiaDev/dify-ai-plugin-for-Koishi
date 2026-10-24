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

/** 控制台插件配置页顶部说明：JSON 对象变量的占位符速查 */
export const usage = `
## JSON 对象变量的占位符

「JSON 对象」分支的模板内可用以下占位符（整个对象注入字段名对应的单一变量）：

| 占位符 | 类型 | 说明 |
| --- | --- | --- |
| \`{{userId}}\` \`{{botId}}\` \`{{guildId}}\` \`{{channelId}}\` \`{{platform}}\` | 字符串 | 会话身份 |
| \`{{messageId}}\` \`{{username}}\` \`{{timestamp}}\` | 字符串 | 消息标识与作者 |
| \`{{content}}\` | 字符串 | 消息原貌 |
| \`{{quoteContent}}\` \`{{quoteAuthorId}}\` | 字符串 | 被引用消息（引用段 / 作者） |
| \`{{triggerType}}\` \`{{ruleName}}\` \`{{triggerTime}}\` | 字符串 | 触发元信息 |
| \`{{history}}\` / \`{{history:N}}\` | 字符串 | 历史消息文本，N 指定条数（缺省用全局配置） |
| \`{{isDirect}}\` | 布尔 | 是否私聊 |

- 值恰好为一个占位符（如 \`"is_private": "{{isDirect}}"\`）时保留原生类型
- 占位符混入其他文字（如 \`"你好 {{username}}"\`）按字符串拼接，引号换行自动转义
- 未知变量得空串
`

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

  ctx.on('ready', async () => {
    // 探测结果持久化缓存先回填：重载后立即按正确类型分流，不再有探测窗口
    // （窗口期内 auto 应用回退 chat 端点，workflow/completion 应用会被 Dify 400 拒绝）
    const cached = await ctx.database.get('dify_app_probe', {}).catch(() => [])
    for (const row of cached) {
      if (apps.has(row.name)) appTypes.set(row.name, row.mode)
    }
    // 先注册触发再后台探测：探测是网络请求（自建/代理下可达数秒），
    // 阻塞 start 会让重载窗口内消息触发完全失灵；探测完成前的请求按 chat 路径回退
    engine.start()
    ctx.logger.info('插件装配完成，耗时 %dms', Date.now() - startedAt)
    const probeStart = Date.now()
    runner.probeTask = probeAppTypes(ctx, apps, appTypes)
    void runner.probeTask.then(() => {
      ctx.logger.info('应用类型探测完成，耗时 %dms', Date.now() - probeStart)
    })
  })

  const admin = ctx.command('dify', { authority: 3 })
  registerMiscCommands(admin, conversationStore)
}

/** 对 appType=auto 的应用并发调 GET /info 探测类型（显式配置类型的应用不探测，无 auto 应用时整体跳过）；
 *  成功结果回写持久化缓存（下次重载直接复用），失败 warn 并回退 chat 路径 */
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
        await ctx.database
          .upsert('dify_app_probe', [{ name: app.name, mode: info.mode, updatedAt: new Date() }])
          .catch((error) => ctx.logger.warn('探测结果写库失败：%s', error))
        ctx.logger.info('应用 %s 类型探测：%s', app.name, info.mode)
      } catch (error) {
        ctx.logger.warn('应用 %s 类型探测失败（按 chat 处理）：%s', app.name, error)
      }
    })
  )
}
