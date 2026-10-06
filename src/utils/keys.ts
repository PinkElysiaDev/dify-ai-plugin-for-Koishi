/**
 * 频道/群标识的统一构造。历史上曾在 6 处内联 `` `${platform}:${id}` ``，
 * 分隔符与回退规则各自漂移，全仓收敛到这两个函数。
 */

/** 频道键：历史缓冲、密度窗口、冷却共用的定位粒度 */
export function channelKeyOf(platform: string, channelId: string): string {
  return `${platform}:${channelId}`
}

/** 群键：无私聊群概念的平台回退到频道 ID */
export function guildKeyOf(platform: string, guildId: string | undefined, channelId: string): string {
  return `${platform}:${guildId ?? channelId}`
}
