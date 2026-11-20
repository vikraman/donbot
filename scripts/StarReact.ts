// Description:
//   Listens for ⭐ reactions on any message and announces when one is added.
//   Demonstrates live reaction listening via the Discord client. Discord only.
//   Each user's star on a message is announced once, at most once per channel per minute,
//   and stars on its own announcements are ignored.
//

import type { Robot, DiscordReaction, DiscordUser } from 'hubot'

import { reactionGuard } from './lib/reactionGuard.ts'
import { defineFeature } from './lib/features.ts'
import { allowsRoom } from './lib/policy.ts'

defineFeature({ id: 'starreact', label: 'Star announcements', level: 'casual', passive: true, stores: 'nothing, but announces who starred whose message' })

const ANNOUNCE_COOLDOWN_MS = 60 * 1000

export default async (robot: Robot) => {
  const client = robot.adapter && robot.adapter.client
  if (!client || typeof client.on !== 'function') return

  const guard = reactionGuard(ANNOUNCE_COOLDOWN_MS)

  client.on('messageReactionAdd', async (reaction: DiscordReaction, user: DiscordUser) => {
    if (user.bot) return
    if (!allowsRoom(robot, reaction.message.channelId, 'starreact')) return
    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch {
        return
      }
    }
    if (reaction.emoji.name !== '⭐') return

    const message = reaction.message
    if (!guard.first(message.id, user.id)) return
    if (!guard.mayReply(message.id, message.channelId)) return
    try {
      guard.remember(await robot.messageRoom(message.channelId, `⭐ ${user.username} starred a message from ${message.author?.username || 'someone'}`))
    } catch (error) {
      robot.logger.warn(`starreact: couldn't reply in ${message.channelId}: ${String(error)}`)
    }
  })
}
