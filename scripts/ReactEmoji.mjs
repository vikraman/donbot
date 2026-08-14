// Description:
//   Reacts with emoji based on message keywords and local sentiment tone. Discord only.
//

import emojiData from 'emojilib' with { type: 'json' }
import abstractKeywords from './lib/abstract-keywords.json' with { type: 'json' }

import { shuffle, chance } from './lib/random.mjs'
import { scoreTone } from './lib/sentiment.mjs'

// emojilib includes common function words as keywords (e.g. "me" -> flag emoji,
// "show" -> TV emoji); filtered out so only meaningful concepts trigger reactions
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'for', 'from',
  'had', 'has', 'have', 'he', 'her', 'him', 'his', 'i', 'if', 'in', 'is',
  'it', 'its', 'me', 'my', 'no', 'not', 'of', 'on', 'or', 'our', 'she',
  'so', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they',
  'this', 'to', 'us', 'was', 'we', 'were', 'what', 'when', 'which', 'who',
  'will', 'with', 'would', 'you', 'your'
])
const MIN_KEYWORD_LENGTH = 4

// abstract nouns/verbs (amount, meaning, level, think...) that are grammatically
// valid emojilib keywords but aren't reaction-worthy concepts; derived offline from
// Brysbaert, Warriner & Kuperman (2014) concreteness norms, filtered to words scoring
// below 4.0/5 that also carry no AFINN sentiment value (so emotion words stay in)
const ABSTRACT_KEYWORDS = new Set(abstractKeywords)

// reverse index: keyword -> candidate emoji, built once from emojilib's emoji -> keywords data
const KEYWORD_EMOJI = new Map()
for (const [emoji, keywords] of Object.entries(emojiData)) {
  for (const keyword of keywords) {
    if (keyword.length < MIN_KEYWORD_LENGTH || STOPWORDS.has(keyword) || ABSTRACT_KEYWORDS.has(keyword)) continue
    if (!KEYWORD_EMOJI.has(keyword)) KEYWORD_EMOJI.set(keyword, [])
    KEYWORD_EMOJI.get(keyword).push(emoji)
  }
}

export const SENTIMENT_EMOJI = {
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

const HISTORY_KEY_PREFIX = 'reactemoji:history:'
const HISTORY_KEY = room => `${HISTORY_KEY_PREFIX}${room}`
const HISTORY_MAX_SIZE = 8

const WORD_PATTERN = /[a-z0-9']+/gi

// stores only the numeric tone, never message text
const recordToneAndGetAverage = (robot, room, comparative) => {
  const history = robot.brain.get(HISTORY_KEY(room)) || []
  const updated = [...history, { comparative, ts: Date.now() }].slice(-HISTORY_MAX_SIZE)
  robot.brain.set(HISTORY_KEY(room), updated)
  return updated.reduce((sum, entry) => sum + entry.comparative, 0) / updated.length
}

export default async (robot) => {
  // hears every message so sentiment can be scored, not just keyword matches
  robot.hear(/.*/, async res => {
    if (chance(SKIP_CHANCE)) return

    const message = res.message.user && res.message.user.message
    if (!message || typeof message.react !== 'function') return

    const text = res.message.text || ''
    const words = [...new Set((text.match(WORD_PATTERN) || []).map(w => w.toLowerCase()))]
    const matchedKeywords = words.filter(word => KEYWORD_EMOJI.has(word))

    const { tone, comparative } = scoreTone(text)
    const average = recordToneAndGetAverage(robot, res.message.room, comparative)
    const sustained = (tone === 'positive' && average > 0) || (tone === 'negative' && average < 0)

    // a single stray keyword shouldn't react on its own; sentiment alone still can
    if (matchedKeywords.length < MIN_KEYWORD_MATCHES && !sustained) return

    // one combined pool: tone sets the vibe, keywords add specific concepts
    const pool = [
      ...(sustained ? SENTIMENT_EMOJI[tone] : []),
      ...(matchedKeywords.length >= MIN_KEYWORD_MATCHES ? matchedKeywords.flatMap(word => KEYWORD_EMOJI.get(word)) : [])
    ]
    if (pool.length === 0) return

    const emojis = [...new Set(shuffle(pool))].slice(0, MAX_REACTIONS_PER_MESSAGE)

    for (const emoji of emojis) {
      await message.react(emoji)
    }
  })
}
