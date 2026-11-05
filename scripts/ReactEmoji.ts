// Description:
//   Occasionally reacts with one fitting emoji for specific vocabulary, plus one sentiment emoji
//   when a conversation's mood clearly shifts. Never reacts over people's reactions. Discord only.
//
// Commands:
//   hubot reactions - show whether emoji reactions are on in this channel
//   hubot reactions off - turn emoji reactions off in this channel
//   hubot reactions on - turn emoji reactions back on in this channel
//

import type { Robot } from 'hubot'

import { entriesWithPrefix } from './lib/brainScan.ts'
import { rawMessageOf } from './lib/discordMessage.ts'
import { EMOJI_VOCAB } from './lib/emojiVocab.ts'
import { pick } from './lib/random.ts'
import { scoreTone } from './lib/sentiment.ts'
import type { ToneResult } from './lib/sentiment.ts'
import { wordRank } from './lib/wordRarity.ts'

// less common mood emojis avoiding basic emojis
export const SENTIMENT_EMOJI: Record<'positive' | 'negative', readonly [string, ...string[]]> = {
  positive: [
    '🫶', '🥹', '🤗', '💃', '🕺', '🤸', '🎆', '🌈', '🍾', '🥂',
    '🪅', '🌞', '🌻', '🦄', '🤠', '😸'
  ],
  negative: [
    '🫠', '😮‍💨', '🥲', '🫤', '😿', '🙃', '🌧️', '⛈️', '🥀', '🫥',
    '😶‍🌫️', '🫣'
  ]
}

// vocabulary scoring
const COMMON_RANK = 2000
const UNCOMMON_RANK = 10000
const NAME_BONUS = 1
const MIN_SCORE = 2

// conversation tone
const TONE_WINDOW_SIZE = 20
const TONE_WINDOW_MS = 30 * 60 * 1000
const TONE_MIN_MESSAGES = 5
const TONE_DECAY = 0.85
const TONE_ENTER = 0.25
const TONE_EXIT = 0.05
// recent messages that must share the mood's sign
const TONE_RECENT = 5
const TONE_MIN_AGREEING = 3

export const REACT_DELAY_MS = 60 * 1000
// same emoji not repeated in a room within this window
export const REPEAT_WINDOW_MS = 30 * 60 * 1000

const DISABLED_KEY = 'reactemoji:disabled'
const TONE_KEY = (room: string): string => `reactemoji:tone:${room}`
const LEGACY_HISTORY_PREFIX = 'reactemoji:history:'

const WORD_PATTERN = /[a-z]+/g

type Mood = 'positive' | 'negative' | 'neutral'

interface ToneEntry {
  comparative: number
  ts: number
}

interface ToneState {
  mood: Mood
  entries: ToneEntry[]
}

interface DisabledBy {
  by: string
  at: number
}

const rankWeight = (word: string): number => {
  const rank = wordRank(word)
  if (rank < COMMON_RANK) return 0
  if (rank < UNCOMMON_RANK) return 1
  return 2
}

// word, then with a plural suffix stripped
const formsOf = (word: string): string[] =>
  [...new Set([word, word.replace(/es$/, ''), word.replace(/s$/, '')])].filter(w => w.length > 0)

// best vocabulary emoji, or null
export const scoreMessage = (text: string): string | null => {
  const scores = new Map<string, number>()
  const add = (emoji: string, weight: number) => scores.set(emoji, (scores.get(emoji) ?? 0) + weight)

  for (const word of new Set(text.toLowerCase().match(WORD_PATTERN) ?? [])) {
    const form = formsOf(word).find(f => EMOJI_VOCAB.names[f] || EMOJI_VOCAB.related[f])
    if (!form) continue
    const weight = rankWeight(form)
    const named = EMOJI_VOCAB.names[form]
    if (named) add(named, weight + NAME_BONUS)
    for (const emoji of EMOJI_VOCAB.related[form] ?? []) add(emoji, weight)
  }

  const best = Math.max(0, ...scores.values())
  if (best < MIN_SCORE) return null
  return pick([...scores].filter(([, score]) => score === best).map(([emoji]) => emoji)) ?? null
}

const isToneState = (value: unknown): value is ToneState =>
  typeof value === 'object' && value !== null &&
  ['positive', 'negative', 'neutral'].includes((value as ToneState).mood) &&
  Array.isArray((value as ToneState).entries)

const roomTone = (entries: ToneEntry[]): number => {
  let total = 0
  let weights = 0
  entries.forEach((entry, i) => {
    const weight = TONE_DECAY ** (entries.length - 1 - i)
    total += entry.comparative * weight
    weights += weight
  })
  return weights === 0 ? 0 : total / weights
}

// numeric tone only, never message text; returns the mood switched into, if any
const recordTone = (robot: Robot, room: string, { tone, comparative }: ToneResult): 'positive' | 'negative' | null => {
  const now = Date.now()
  const stored = robot.brain.get(TONE_KEY(room))
  const previous = isToneState(stored) ? stored : { mood: 'neutral' as Mood, entries: [] }
  const entries = [...previous.entries.filter(e => now - e.ts < TONE_WINDOW_MS), { comparative, ts: now }].slice(-TONE_WINDOW_SIZE)

  let mood = previous.mood
  let switched: 'positive' | 'negative' | null = null
  if (entries.length < TONE_MIN_MESSAGES) {
    mood = 'neutral'
  } else {
    const average = roomTone(entries)
    const recent = entries.slice(-TONE_RECENT)
    const agreeing = (sign: number) => recent.filter(e => Math.sign(e.comparative) === sign).length >= TONE_MIN_AGREEING
    if (mood !== 'positive' && tone === 'positive' && average >= TONE_ENTER && agreeing(1)) {
      mood = switched = 'positive'
    } else if (mood !== 'negative' && tone === 'negative' && average <= -TONE_ENTER && agreeing(-1)) {
      mood = switched = 'negative'
    } else if (Math.abs(average) < TONE_EXIT) {
      mood = 'neutral'
    }
  }

  robot.brain.set(TONE_KEY(room), { mood, entries })
  return switched
}

const disabledRooms = (robot: Robot): Record<string, DisabledBy> => {
  const stored = robot.brain.get(DISABLED_KEY)
  return typeof stored === 'object' && stored !== null ? stored as Record<string, DisabledBy> : {}
}

const isDisabled = (robot: Robot, room: string): boolean => room in disabledRooms(robot)

const addressesBot = (robot: Robot, text: string): boolean => {
  const names = [robot.name, robot.alias].filter((n): n is string => Boolean(n)).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^\\s*@?(?:${names.join('|')})\\b`, 'i').test(text)
}

export default async (robot: Robot) => {
  // room -> emoji -> last reacted at
  const recent = new Map<string, Map<string, number>>()
  // claims the emoji for the room unless used within the window
  const claimFresh = (room: string, emoji: string | null): string | null => {
    if (!emoji) return null
    const now = Date.now()
    const used = recent.get(room) ?? new Map<string, number>()
    for (const [e, ts] of used) if (now - ts >= REPEAT_WINDOW_MS) used.delete(e)
    recent.set(room, used)
    if (used.has(emoji)) return null
    used.set(emoji, now)
    return emoji
  }

  robot.brain.on('loaded', () => {
    for (const [suffix] of entriesWithPrefix(robot, LEGACY_HISTORY_PREFIX)) {
      robot.brain.remove(`${LEGACY_HISTORY_PREFIX}${suffix}`)
    }
  })

  robot.respond(/reactions(?: (on|off|status))?$/i, async res => {
    const room = res.message.room
    const action = (res.match[1] || 'status').toLowerCase()
    const rooms = disabledRooms(robot)

    if (action === 'off') {
      robot.brain.set(DISABLED_KEY, { ...rooms, [room]: { by: res.message.user.name, at: Date.now() } })
      await res.send(`Emoji reactions off in this channel. \`${robot.name} reactions on\` brings them back.`)
    } else if (action === 'on') {
      const { [room]: _, ...rest } = rooms
      robot.brain.set(DISABLED_KEY, rest)
      await res.send('Emoji reactions on in this channel.')
    } else {
      const disabled = rooms[room]
      await res.send(disabled
        ? `Emoji reactions are off in this channel (turned off by ${disabled.by} on ${new Date(disabled.at).toISOString().slice(0, 10)}).`
        : 'Emoji reactions are on in this channel.')
    }
  })

  // hears everything so the room's tone is tracked
  robot.hear(/.*/, async res => {
    const room = res.message.room
    const text = res.message.text || ''
    const mood = recordTone(robot, room, scoreTone(text))

    if (isDisabled(robot, room) || addressesBot(robot, text)) return

    const message = rawMessageOf(res)
    if (!message || typeof message.react !== 'function') return

    const vocab = scoreMessage(text)
    const sentiment = mood && pick(SENTIMENT_EMOJI[mood])
    if (!vocab && !sentiment) return

    // reaction delay so people's reactions land first
    const timer = setTimeout(async () => {
      if (isDisabled(robot, room)) return
      if (message.reactions && message.reactions.cache.size > 0) return
      try {
        // vocab emoji not repeated; sentiment is limited by mood switches
        const emojis = [...new Set([claimFresh(room, vocab), sentiment].filter((e): e is string => Boolean(e)))]
        for (const emoji of emojis) await message.react(emoji)
      } catch (error) {
        robot.logger.debug(`reactemoji: react failed: ${String(error)}`)
      }
    }, REACT_DELAY_MS)
    timer.unref?.()
  })
}
