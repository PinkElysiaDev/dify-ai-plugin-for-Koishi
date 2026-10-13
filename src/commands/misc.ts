import { Command } from 'koishi'
import { ConversationStore } from '../state/conversation'
import { channelKeyOf, guildKeyOf } from '../utils/keys'

/** dify.conv.reset 维护命令（authority 3） */
export function registerMiscCommands(parent: Command, conversationStore: ConversationStore) {
  parent.subcommand('.conv.reset', { authority: 3 })
    .action(async ({ session }) => {
      const reset = await conversationStore.resetWhere({
        guildKey: guildKeyOf(session.platform, session.guildId, session.channelId),
        channelKey: channelKeyOf(session.platform, session.channelId),
        isDirect: session.isDirect,
        userId: session.userId
      })
      if (!reset) return session.text('dify-ai.commands.conv-empty')
      return session.text('dify-ai.commands.conv-reset', [reset])
    })
}
