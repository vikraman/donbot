// Description:
//   Reacts with emoji based on message keywords and local sentiment tone. Discord only.
//

import type { Robot } from 'hubot'

import emojiData from 'emojilib' with { type: 'json' }
import abstractKeywords from './lib/abstract-keywords.json' with { type: 'json' }

import { rawMessageOf } from './lib/discordMessage.ts'
import { pick, shuffle, chance } from './lib/random.ts'
import { scoreTone } from './lib/sentiment.ts'

// drop emojilib function-word keywords
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in', 'is',
  'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she',
  'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who',
  'will', 'with', 'would', 'you', 'your'
])
const MIN_KEYWORD_LENGTH = 4

// abstract keywords, from Brysbaert et al. (2014) concreteness norms
const ABSTRACT_KEYWORDS = new Set(abstractKeywords)

// reverse index: keyword -> emoji
const KEYWORD_EMOJI = new Map<string, [string, ...string[]]>()
for (const [emoji, keywords] of Object.entries(emojiData as unknown as Record<string, string[]>)) {
  for (const keyword of keywords) {
    if (keyword.length < MIN_KEYWORD_LENGTH || STOPWORDS.has(keyword) || ABSTRACT_KEYWORDS.has(keyword)) continue
    const existing = KEYWORD_EMOJI.get(keyword)
    if (existing) existing.push(emoji)
    else KEYWORD_EMOJI.set(keyword, [emoji])
  }
}

export const SENTIMENT_EMOJI: Record<'positive' | 'negative', readonly [string, ...string[]]> = {
  positive: [
    '🎉', '❤️', '🔥', '🥳', '😍', '👏', '💯', '🤩', '✨', '🙌',
    '😄', '😊', '💪', '🚀', '👍', '💕', '😻', '🏆', '💐', '🎊',
    '😎', '🙏', '💖', '🥰', '⭐'
  ],
  negative: [
    '😢', '😬', '😞', '😔', '😤', '😡', '😠', '💔', '😭', '😕',
    '😣', '👎', '😰', '😨', '🤦', '😩'
  ]
}

const MAX_REACTIONS_PER_MESSAGE = 5
const SKIP_CHANCE = 0.15
const MIN_KEYWORD_MATCHES = 2

interface ToneHistoryEntry {
  comparative: number
  ts: number
}

const HISTORY_KEY_PREFIX = 'reactemoji:history:'
const HISTORY_KEY = (room: string): string => `${HISTORY_KEY_PREFIX}${room}`
const HISTORY_MAX_SIZE = 8

const WORD_PATTERN = /[a-z0-9']+/gi

// numeric tone only, never message text
const recordToneAndGetAverage = (robot: Robot, room: string, comparative: number): number => {
  const history = robot.brain.get<ToneHistoryEntry[]>(HISTORY_KEY(room)) || []
  const updated = [...history, { comparative, ts: Date.now() }].slice(-HISTORY_MAX_SIZE)
  robot.brain.set(HISTORY_KEY(room), updated)
  return updated.reduce((sum, entry) => sum + entry.comparative, 0) / updated.length
}

export default async (robot: Robot) => {
  // hears everything so sentiment is scored
  robot.hear(/.*/, async res => {
    if (chance(SKIP_CHANCE)) return

    const message = rawMessageOf(res)
    if (!message || typeof message.react !== 'function') return

    const text = res.message.text || ''
    const words = [...new Set((text.match(WORD_PATTERN) || []).map(w => w.toLowerCase()))]
    const matchedKeywords = words.filter(word => KEYWORD_EMOJI.has(word))

    const { tone, comparative } = scoreTone(text)
    const average = recordToneAndGetAverage(robot, res.message.room, comparative)
    const sustained = (tone === 'positive' && average > 0) || (tone === 'negative' && average < 0)

    // one stray keyword is not enough; sentiment alone is
    if (matchedKeywords.length < MIN_KEYWORD_MATCHES && !sustained) return

    // one emoji per signal
    const candidates = [
      ...(sustained && (tone === 'positive' || tone === 'negative') ? [pick(SENTIMENT_EMOJI[tone])] : []),
      ...(matchedKeywords.length >= MIN_KEYWORD_MATCHES ? matchedKeywords.map(word => pick(KEYWORD_EMOJI.get(word)!)) : [])
    ]
    if (candidates.length === 0) return

    const emojis = [...new Set(shuffle(candidates))].slice(0, MAX_REACTIONS_PER_MESSAGE)

    for (const emoji of emojis) {
      await message.react(emoji)
    }
  })
}
