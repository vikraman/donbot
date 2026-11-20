// Description:
//   Says a short hello when donbot joins a server, and waves at people who join after it. Discord only.
//

import type { Robot } from 'hubot'

import { defineFeature } from './lib/features.ts'
import { allowsRoom, policyFor } from './lib/policy.ts'

defineFeature({ id: 'welcome', label: 'Welcomes', level: 'professional' })

// discord.js MessageType.UserJoin
const USER_JOIN = 7
const WAVE = '👋'

interface JoinedGuild {
  id: string
  systemChannel?: { send: (text: string) => Promise<unknown> } | null
}

interface JoinMessage {
  type?: number
  guildId?: string | null
  channelId: string
  author?: { id?: string, bot?: boolean }
  react: (emoji: string) => Promise<unknown>
}

export const hello = (name: string): string =>
  `👋 Hi, I'm ${name}, a helper bot. Start a message with \`${name}\` to talk to me; \`${name} help\` lists what I can do.`

export default async (robot: Robot) => {
  const client = robot.adapter?.client
  if (!client || typeof client.on !== 'function') return

  client.on('guildCreate', async (...args: unknown[]) => {
    const guild = args[0] as JoinedGuild
    // a server we already know is a rejoin
    if (policyFor(robot).data().guilds[guild.id] || !guild.systemChannel) return
    try {
      await guild.systemChannel.send(hello(robot.name))
    } catch (err) {
      robot.logger.warn(`welcome: couldn't say hello in ${guild.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })

  client.on('messageCreate', async (...args: unknown[]) => {
    const message = args[0] as JoinMessage
    if (message.type !== USER_JOIN || !message.guildId || message.author?.bot) return
    if (!allowsRoom(robot, message.channelId, 'welcome')) return
    try {
      await message.react(WAVE)
    } catch (err) {
      robot.logger.warn(`welcome: couldn't wave in ${message.channelId}: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}
