// Description:
//   Praise the bot for a job well done. Tracks praise count.
//
// Commands:
//   hubot cookie - Gives the bot a cookie.
//   hubot good bot - Praises the bot.
//   hubot good job - Same as "good bot".
//   hubot good boy donbot - Same as "good bot".
//   hubot praise count - Shows how many times the bot has been praised.
//   hubot who praised you - Lists who has praised the bot and how often.
//
// Also reacts to positive-affirmation emoji reactions on the bot's own messages. Discord only.
// (⭐ excluded — StarReact.mjs owns it.) Each user counts once per message; replies are
// limited to one per channel per minute, and praise of its own acknowledgements is
// counted without a reply.
//

import type { Robot, DiscordReaction, DiscordUser } from 'hubot'

import { entriesWithPrefix, isScore, scoreAt } from './lib/brainScan.ts'
import { mentionFor } from './lib/mention.ts'
import { defineLines } from './lib/lines.ts'
import { reactionGuard } from './lib/reactionGuard.ts'
import { isApproval } from './lib/reactions.ts'
import { scoreTone } from './lib/sentiment.ts'
import { defaultTz, userTz } from './lib/timezone.ts'

const PRAISE_COUNT_KEY = 'praise:count'
const PRAISE_BY_USER_PREFIX = 'praise:user:'

export const GRUDGING_LINES = [
  "Heh, yeah, I know I'm good.",
  'Not bad yourself, for a mark.',
  "Alright, alright, don't wear it out.",
  "Flattery. Noted. Filed. Mostly ignored.",
  "I'll allow it.",
  "Sure, sure. Put it on the list with the others.",
  "You're only saying that 'cause it's true.",
  "Don't get sentimental on me, kid.",
  "Yeah, yeah. Now beat it, I'm busy.",
  "Compliment received. Ego unchanged. Mostly.",
  "Careful, I might start to like you.",
  "That and a dollar gets you a bad coffee. But thanks."
] as const

export const ENTHUSIASTIC_LINES = [
  "That's more like it. Keep it coming.",
  'See, was that so hard? A little respect.',
  "I'll add that to my tab. You owe me plenty more.",
  'I do good work. Glad somebody noticed.',
  'Finally, someone with taste.',
  "Now that's the kind of talk I like to hear.",
  "Keep this up and you're getting a promotion. Unpaid, but a promotion.",
  "You just made a robot very smug. Hope you're happy.",
  "Respect like that, I don't forget.",
  'Music to my audio sensors.',
  'Say it louder, for the folks in the back.',
  "You've got a good eye. I'll remember your face. In a nice way."
] as const

const PRAISE_RARE = [
  "🍪 I'm putting this cookie in a tiny frame on my tiny desk.",
  '📜 Praise logged in the permanent family record. Your name is now in the good book.',
  "🎩 Tips hat. I don't have a hat. I'm tipping it anyway.",
  "🤖 Error 200: OK. Extremely OK. Pleased, even.",
  '🌹 *dabs at optical sensor* Somebody cut onions in the server room.'
] as const

const PRAISE_AI = { about: 'donbot, a dry-witted robot with mafia-boss swagger, accepting a compliment or a cookie from a teammate', slots: [] } as const

// flat thanks draws from both tones
const reply = defineLines('praise.reply', { fallback: [...GRUDGING_LINES, ...ENTHUSIASTIC_LINES], rare: PRAISE_RARE, flair: true, ai: PRAISE_AI })
const enthusiastic = defineLines('praise.enthusiastic', { fallback: ENTHUSIASTIC_LINES, rare: PRAISE_RARE, flair: true, ai: { ...PRAISE_AI, about: `${PRAISE_AI.about}, especially effusive praise` } })

const REACTION_REPLY_COOLDOWN_MS = 60 * 1000

// only enthusiastic text narrows the pool
const linesFor = (text?: string) => text && scoreTone(text).tone === 'positive' ? enthusiastic : reply

const recordPraise = (robot: Robot, userId?: string): number => {
  const count = scoreAt(robot, PRAISE_COUNT_KEY) + 1
  robot.brain.set(PRAISE_COUNT_KEY, count)

  if (userId != null) {
    const key = `${PRAISE_BY_USER_PREFIX}${userId}`
    robot.brain.set(key, scoreAt(robot, key) + 1)
  }

  return count
}

export default async (robot: Robot) => {
  const guard = reactionGuard(REACTION_REPLY_COOLDOWN_MS)

  robot.respond(/(?:cookie|good (?:bot|job)|good boy(?: donbot)?|thanks?(?: you)?)[.!]*$/i, async res => {
    recordPraise(robot, res.message.user.id)
    const line = linesFor(res.message.text)({}, { room: res.message.room, tz: userTz(robot, res.message.user.id) })
    guard.remember(await res.send(line))
  })

  robot.respond(/praise count$/i, async res => {
    const count = scoreAt(robot, PRAISE_COUNT_KEY)
    await res.send(count === 1 ? "I've been praised once." : `I've been praised ${count} times.`)
  })

  robot.respond(/who praised you\??$/i, async res => {
    const praisers = entriesWithPrefix(robot, PRAISE_BY_USER_PREFIX, isScore)
      .map(([userId, count]) => ({ userId, count }))
      .sort((a, b) => b.count - a.count)

    if (praisers.length === 0) {
      await res.send('Nobody. Real quiet out there.')
      return
    }

    const lines = praisers.map(({ userId, count }) => {
      const user = robot.brain.data.users && robot.brain.data.users[userId]
      const mention = mentionFor({ id: userId, name: user && user.name })
      return `${mention}: ${count === 1 ? 'once' : `${count} times`}`
    })
    await res.send(lines.join('\n'))
  })

  const client = robot.adapter && robot.adapter.client
  if (!client || typeof client.on !== 'function') return

  client.on('messageReactionAdd', async (reaction: DiscordReaction, user: DiscordUser) => {
    if (user.bot) return
    if (!isApproval(reaction.emoji.name)) return
    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch {
        return
      }
    }

    const message = reaction.message
    if (message.author?.id !== client.user?.id) return

    // once per user per message, across emoji and re-adds
    if (!guard.first(message.id, user.id)) return

    recordPraise(robot, user.id)
    if (!guard.mayReply(message.id, message.channelId)) return
    try {
      guard.remember(await robot.messageRoom(message.channelId, reply({}, { room: message.channelId, tz: defaultTz() })))
    } catch (error) {
      // e.g. a locked thread; an unhandled rejection here would take the bot down
      robot.logger.warn(`praise: couldn't reply in ${message.channelId}: ${String(error)}`)
    }
  })
}
