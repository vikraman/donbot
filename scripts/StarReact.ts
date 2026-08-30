// Description:
//   Listens for ⭐ reactions on any message and announces when one is added.
//   Demonstrates live reaction listening via the Discord client. Discord only.
//

import type { Robot, DiscordReaction, DiscordUser } from 'hubot'

export default async (robot: Robot) => {
  const client = robot.adapter && robot.adapter.client
  if (!client || typeof client.on !== 'function') return

  client.on('messageReactionAdd', async (reaction: DiscordReaction, user: DiscordUser) => {
    if (user.bot) return
    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch {
        return
      }
    }
    if (reaction.emoji.name !== '⭐') return

    const message = reaction.message
    await robot.messageRoom(message.channelId, `⭐ ${user.username} starred a message from ${message.author?.username || 'someone'}`)
  })
}
