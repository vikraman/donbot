// Description:
//   Rate-limits commands per user/room. Past the limit, stops responding and tells them to
//   get back to work. Repeat offenders get exponentially longer cooldowns.
//
// Commands:
//   hubot who's rate limited - (Owner only) Lists users currently in a rate-limit cooldown.
//   hubot rate limits - Same as above.
//   hubot rate limit status - Same as above.
//
// Configuration:
//   OWNER_USER_ID - Discord user ID exempted from rate limiting. Optional.
//

import { mentionFor } from './lib/mention.mjs'

const WINDOW_MS = 60 * 1000
const MAX_COMMANDS_PER_WINDOW = 5
const BASE_COOLDOWN_MS = 30 * 1000
const MAX_COOLDOWN_MS = 30 * 60 * 1000
const OFFENSE_RESET_AFTER_MS = 15 * 60 * 1000

const RATE_KEY_PREFIX = 'ratelimit:'
const RATE_KEY = (userId, room) => `${RATE_KEY_PREFIX}${userId}:${room}`
const parseRateKey = key => {
  const rest = key.slice(RATE_KEY_PREFIX.length)
  const sep = rest.indexOf(':')
  return { userId: rest.slice(0, sep), room: rest.slice(sep + 1) }
}

const formatDuration = ms => {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

const roomName = (robot, room) => {
  const client = robot.adapter && robot.adapter.client
  const channel = client && client.channels && client.channels.cache && client.channels.cache.get(room)
  return (channel && channel.name) ? `#${channel.name}` : room
}

const DISMISSALS = [
  "You're startin' to bore me, and I don't like being bored. Get lost.",
  "That's enough outta you. Go find something useful to do before I lose my patience.",
  "You keep flashing that mouth around and I'm gonna have to have a word with you. Beat it.",
  "I got no more time for you today. Go do your job or whatever it is you're supposed to be doing.",
  "You're testing my patience, and my patience has a real short fuse. Scram.",
  "Alright, that's it. You're cut off. Go be productive somewhere I can't see you.",
  "Nobody likes a pest. Go on, get outta here."
]

const pick = options => options[Math.floor(Math.random() * options.length)]

const escapeRegExp = str => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isAddressedToBot = (robot, text) => {
  const robotPattern = new RegExp(`^[@]?${escapeRegExp(robot.name)}[:,]?\\s+`, 'i')
  const aliasPattern = robot.alias ? new RegExp(`^[@]?${escapeRegExp(robot.alias)}[:,]?\\s+`, 'i') : null
  return robotPattern.test(text) || (aliasPattern && aliasPattern.test(text))
}

// Doubles per consecutive offense: 30s, 1m, 2m, 4m, ... capped at MAX_COOLDOWN_MS.
const cooldownFor = offenseCount =>
  Math.min(BASE_COOLDOWN_MS * 2 ** (offenseCount - 1), MAX_COOLDOWN_MS)

export default async (robot) => {
  robot.receiveMiddleware(async (context) => {
    const message = context.response.message
    if (message.constructor.name !== 'TextMessage') return true

    const text = message.text || ''
    if (!isAddressedToBot(robot, text)) return true

    const user = message.user
    if (!user || user.id == null) return true

    const ownerId = process.env.OWNER_USER_ID
    if (ownerId && String(user.id) === ownerId) return true

    const key = RATE_KEY(user.id, message.room)
    const now = Date.now()
    const state = robot.brain.get(key) || { hits: [], dismissedUntil: 0, offenseCount: 0, lastOffenseAt: 0 }

    if (now < state.dismissedUntil) {
      return false
    }

    if (state.offenseCount > 0 && now - state.lastOffenseAt > OFFENSE_RESET_AFTER_MS) {
      state.offenseCount = 0
    }

    state.hits = state.hits.filter(t => now - t < WINDOW_MS)
    state.hits.push(now)

    if (state.hits.length > MAX_COMMANDS_PER_WINDOW) {
      state.offenseCount += 1
      state.lastOffenseAt = now
      state.dismissedUntil = now + cooldownFor(state.offenseCount)
      state.hits = []
      robot.brain.set(key, state)
      await context.response.send(pick(DISMISSALS))
      return false
    }

    robot.brain.set(key, state)
    return true
  })

  robot.respond(/(?:who'?s rate limited|rate limits?|rate limit status)\??$/i, async res => {
    const ownerId = process.env.OWNER_USER_ID
    if (!ownerId || String(res.message.user.id) !== ownerId) {
      await res.send("That's need-to-know, and you don't need to know.")
      return
    }

    const now = Date.now()
    const data = robot.brain.data._private || {}
    const limited = Object.keys(data)
      .filter(key => key.startsWith(RATE_KEY_PREFIX))
      .map(key => ({ ...parseRateKey(key), state: data[key] }))
      .filter(({ state }) => state && now < state.dismissedUntil)

    if (limited.length === 0) {
      await res.send('Nobody in the doghouse right now.')
      return
    }

    const lines = limited.map(({ userId, room, state }) => {
      const user = robot.brain.data.users && robot.brain.data.users[userId]
      const mention = mentionFor({ id: userId, name: user && user.name })
      return `${mention} in ${roomName(robot, room)}: ${formatDuration(state.dismissedUntil - now)} left (offense #${state.offenseCount})`
    })
    await res.send(lines.join('\n'))
  })
}
