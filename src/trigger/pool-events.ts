import { Context, Session } from 'koishi'
import { HistoryEntry } from '../history'
import { channelKeyOf } from '../utils/keys'
import { MessagePool } from './pool'

/**
 * 事件缓冲池采集：把群事件构造为 role='event' 条目写入消息池，供密度与定时摘要当上下文。
 * 事件条目不推高密度（计数只认 user 消息）、不带图、不进历史变量；撤回走 markDeleted 标注已有条目。
 * 新增事件：在 buildNoticeEntry / buildMemberEntry 追加 subtype 分支，
 * 或在 registerPoolEvents 增加监听——koishi 标准事件名跨平台，adapter 扩展名（notice / guild-member）
 * 仅对应平台触发，其它平台收不到该事件就没有条目，无需平台判断。
 */

/** 事件主体的呈现（notice 类事件通常不带昵称，退化为纯 ID 形态） */
function actorOf(session: Session): string {
  return `${session.username || session.userId} (${session.userId})`
}

/** 事件条目：content 即完整事件文案（统一格式行按事件模板渲染，不走「说：」） */
function eventEntry(session: Session, content: string): HistoryEntry {
  return {
    role: 'event',
    userId: session.userId ?? '',
    username: session.username || session.userId || '',
    content,
    contentText: content,
    timestamp: session.timestamp ?? Date.now()
  }
}

/** OneBot 扩展 notice：戳一戳 / 红包运气王 / 群荣誉 */
function buildNoticeEntry(session: Session): HistoryEntry | null {
  const actor = actorOf(session)
  switch (session.subtype) {
    case 'poke': {
      // 被戳者在非标准字段 targetId（adapter-onebot 设置）
      const target = (session as any).targetId
      if (!target) return null
      return eventEntry(session, `${actor} 戳了 ${target === session.selfId ? 'bot' : target}`)
    }
    case 'lucky-king':
      return eventEntry(session, `${actor} 成为红包运气王`)
    case 'honor':
      return eventEntry(session, `${actor} 获得群荣誉`)
    default:
      return null
  }
}

/** OneBot 扩展 guild-member：管理员 / 禁言 / 群名片（细节字段在 onebot 原始载荷上） */
function buildMemberEntry(session: Session): HistoryEntry | null {
  const actor = actorOf(session)
  const payload = (session as any).onebot ?? {}
  switch (session.subtype) {
    // set/remove 被 adapter 覆盖为 role，原始值只在载荷
    case 'role':
      return eventEntry(session, `${actor} ${payload.sub_type === 'remove' ? '被取消管理员' : '被设为管理员'}`)
    case 'ban': {
      if (payload.sub_type === 'lift_ban') return eventEntry(session, `${actor} 被解除禁言`)
      const seconds = Number(payload.duration) || 0
      return eventEntry(session, `${actor} 被禁言${seconds > 0 ? ` ${seconds} 秒` : ''}`)
    }
    case 'nickname':
      return eventEntry(session, `${actor} 修改了群名片`)
    default:
      return null
  }
}

/** 入群（标准事件，subtype active 主动 / passive 受邀） */
function buildJoinEntry(session: Session): HistoryEntry | null {
  const invitedBy = session.subtype === 'passive' && session.operatorId
  return eventEntry(session, `${actorOf(session)} 加入群聊${invitedBy ? `（由 ${session.operatorId} 邀请）` : ''}`)
}

/** 退群（标准事件，subtype active 主动 / passive 被移出） */
function buildLeaveEntry(session: Session): HistoryEntry | null {
  if (session.subtype === 'passive' && session.operatorId) {
    return eventEntry(session, `${actorOf(session)} 被 ${session.operatorId} 移出群聊`)
  }
  return eventEntry(session, `${actorOf(session)} 离开群聊`)
}

/** 可入池的事件会话：有频道定位且主体不是 bot 自身（bot 进出群是独立的 guild-added/removed 事件，不采集） */
function recordable(session: Session): boolean {
  return !!session.channelId && !!session.userId && session.userId !== session.selfId
}

export function registerPoolEvents(ctx: Context, pool: MessagePool) {
  const collect = (build: (session: Session) => HistoryEntry | null) => (session: Session) => {
    if (!recordable(session)) return
    const entry = build(session)
    if (entry) pool.record(session, entry)
  }
  ctx.on('notice' as any, collect(buildNoticeEntry))
  ctx.on('guild-member' as any, collect(buildMemberEntry))
  ctx.on('guild-member-added', collect(buildJoinEntry))
  ctx.on('guild-member-removed', collect(buildLeaveEntry))
  ctx.on('message-deleted', (session: Session) => {
    if (!session.channelId || !session.messageId) return
    pool.markDeleted(channelKeyOf(session.platform, session.channelId), session.messageId)
  })
}
