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

import type { Robot, MiddlewareContext } from 'hubot'

import { entriesWithPrefix } from './lib/brainScan.ts'
import { mentionFor } from './lib/mention.ts'
import { pick } from './lib/random.ts'

const WINDOW_MS = 60 * 1000
const MAX_COMMANDS_PER_WINDOW = 5
const BASE_COOLDOWN_MS = 30 * 1000
const MAX_COOLDOWN_MS = 30 * 60 * 1000
const OFFENSE_RESET_AFTER_MS = 15 * 60 * 1000

const RATE_KEY_PREFIX = 'ratelimit:'
const RATE_KEY = (userId: string, room: string): string => `${RATE_KEY_PREFIX}${userId}:${room}`
// a stale key without the separator would otherwise slice into nonsense
const parseRateKeySuffix = (suffix: string): { userId: string, room: string } | null => {
  const sep = suffix.indexOf(':')
  if (sep < 0) return null
  return { userId: suffix.slice(0, sep), room: suffix.slice(sep + 1) }
}

const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(Math.ceil(ms / 1000), 0)
  const m = Math.floor(totalSeconds / 60)
  const s = totalSeconds % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

const roomName = (robot: Robot, room: string): string => {
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
] as const

const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const isAddressedToBot = (robot: Robot, text: string): boolean => {
  const robotPattern = new RegExp(`^[@]?${escapeRegExp(robot.name)}[:,]?\\s+`, 'i')
  const aliasPattern = robot.alias ? new RegExp(`^[@]?${escapeRegExp(robot.alias)}[:,]?\\s+`, 'i') : null
  return robotPattern.test(text) || Boolean(aliasPattern && aliasPattern.test(text))
}

// doubles per offense, capped at MAX_COOLDOWN_MS
const cooldownFor = (offenseCount: number): number =>
  Math.min(BASE_COOLDOWN_MS * 2 ** (offenseCount - 1), MAX_COOLDOWN_MS)

interface RateState {
  hits: number[]
  dismissedUntil: number
  offenseCount: number
  lastOffenseAt: number
}

const isRateState = (value: unknown): value is RateState =>
  typeof value === 'object' && value !== null &&
  Array.isArray((value as RateState).hits) &&
  typeof (value as RateState).dismissedUntil === 'number' &&
  typeof (value as RateState).offenseCount === 'number' &&
  typeof (value as RateState).lastOffenseAt === 'number'

export default async (robot: Robot) => {
  robot.receiveMiddleware(async (context: MiddlewareContext) => {
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
    const stored = robot.brain.get(key)
    // a stale/malformed value would throw in the middleware and wedge the room
    const state = isRateState(stored) ? stored : { hits: [], dismissedUntil: 0, offenseCount: 0, lastOffenseAt: 0 }

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
    const limited = entriesWithPrefix(robot, RATE_KEY_PREFIX, isRateState)
      .flatMap(([suffix, state]) => {
        const parsed = parseRateKeySuffix(suffix)
        return parsed ? [{ ...parsed, state }] : []
      })
      .filter(({ state }) => now < state.dismissedUntil)

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
