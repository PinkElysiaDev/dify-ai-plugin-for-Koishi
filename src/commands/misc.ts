import { Command } from 'koishi'
import { ConversationStore } from '../state/conversation'
import { guildKeyOf } from '../utils/keys'

/** dify.conv.reset 维护命令（authority 3） */
export function registerMiscCommands(parent: Command, conversationStore: ConversationStore) {
  parent.subcommand('.conv.reset', { authority: 3 })
    .action(async ({ session }) => {
      const guildKey = guildKeyOf(session.platform, session.guildId, session.channelId)
      const reset = await conversationStore.resetWhere({ guildKey })
      if (!reset) return session.text('dify-ai.commands.conv-empty')
      return session.text('dify-ai.commands.conv-reset', [reset])
    })
}
