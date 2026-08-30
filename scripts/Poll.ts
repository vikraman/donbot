// Description:
//   Runs a thumbs up/down poll and reports the tally on demand. Discord only.
//
// Commands:
//   hubot poll <question> - Posts a 👍/👎 poll for <question>.
//   hubot poll results - Shows the tally for the most recent poll in this room.
//

import type { Robot, DiscordMessage } from 'hubot'

import { required } from './lib/match.ts'

import { rawMessageOf } from './lib/discordMessage.ts'

interface PollState {
  question: string
  messageId: string
}

const UP = '👍'
const DOWN = '👎'

const pollKey = (room: string): string => `poll:${room}`

const countVotes = async (message: DiscordMessage, emoji: string): Promise<number> => {
  const reaction = message.reactions.cache.get(emoji)
  if (!reaction) return 0
  if (reaction.partial) await reaction.fetch()
  return Math.max(reaction.count - 1, 0)
}

export default async (robot: Robot) => {
  robot.respond(/poll results$/i, async res => {
    const poll = robot.brain.get<PollState>(pollKey(res.message.room))
    if (!poll) {
      await res.send('No poll has been run in this room yet.')
      return
    }

    const rawMessage = rawMessageOf(res)
    const channel = rawMessage && rawMessage.channel
    if (!channel) {
      await res.send("Can't look up poll results outside Discord.")
      return
    }

    const message = await channel.messages.fetch(poll.messageId)
    const up = await countVotes(message, UP)
    const down = await countVotes(message, DOWN)
    await res.send(`"${poll.question}" — ${UP} ${up} / ${DOWN} ${down}`)
  })

  robot.respond(/poll (.+)$/i, async res => {
    const question = required(res.match, 1).trim()
    const rawMessage = rawMessageOf(res)
    const channel = rawMessage && rawMessage.channel

    if (!channel || typeof channel.send !== 'function') {
      await res.send("Polls only work in Discord channels, sorry.")
      return
    }

    const sent = await channel.send(`📊 ${question}`)
    await sent.react(UP)
    await sent.react(DOWN)

    robot.brain.set(pollKey(res.message.room), { question, messageId: sent.id })
    await res.send('Poll posted! Vote with the reactions above.')
  })
}
