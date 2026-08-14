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
// (⭐ excluded — StarReact.mjs owns it.)
//

import { mentionFor } from './lib/mention.mjs'

const PRAISE_COUNT_KEY = 'praise:count'
const PRAISE_BY_USER_PREFIX = 'praise:user:'
const PRAISE_EMOJI = [
  '👍', '❤️', '🎉', '🙌', '👏', '💯', '🔥', '😍', '🥳',
  '👌', '💪', '🙏', '💖', '💕', '😻', '🫡', '✨', '🏆', '🎖️', '🥇', '👑', '💐', '🤩', '😎', '🤌'
]

const pick = options => options[Math.floor(Math.random() * options.length)]

const REACTIONS = [
  "Heh, yeah, I know I'm good.",
  "That's more like it. Keep it coming.",
  "See, was that so hard? A little respect.",
  "I'll add that to my tab. You owe me plenty more.",
  "Not bad yourself, for a mark.",
  "I do good work. Glad somebody noticed.",
  "Alright, alright, don't wear it out."
]

const recordPraise = (robot, userId) => {
  const count = (robot.brain.get(PRAISE_COUNT_KEY) || 0) + 1
  robot.brain.set(PRAISE_COUNT_KEY, count)

  if (userId != null) {
    const key = `${PRAISE_BY_USER_PREFIX}${userId}`
    robot.brain.set(key, (robot.brain.get(key) || 0) + 1)
  }

  return count
}

export default async (robot) => {
  robot.respond(/(?:cookie|good (?:bot|job)|good boy(?: donbot)?|thanks?(?: you)?)[.!]*$/i, async res => {
    recordPraise(robot, res.message.user.id)
    await res.send(pick(REACTIONS))
  })

  robot.respond(/praise count$/i, async res => {
    const count = robot.brain.get(PRAISE_COUNT_KEY) || 0
    await res.send(count === 1 ? "I've been praised once." : `I've been praised ${count} times.`)
  })

  robot.respond(/who praised you\??$/i, async res => {
    const data = robot.brain.data._private || {}
    const praisers = Object.keys(data)
      .filter(key => key.startsWith(PRAISE_BY_USER_PREFIX))
      .map(key => ({ userId: key.slice(PRAISE_BY_USER_PREFIX.length), count: data[key] }))
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

  client.on('messageReactionAdd', async (reaction, user) => {
    if (user.bot) return
    if (!PRAISE_EMOJI.includes(reaction.emoji.name)) return
    if (reaction.partial) {
      try {
        await reaction.fetch()
      } catch {
        return
      }
    }

    const message = reaction.message
    if (message.author?.id !== client.user?.id) return

    recordPraise(robot, user.id)
    await robot.messageRoom(message.channelId, pick(REACTIONS))
  })
}
