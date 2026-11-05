// writes emoji vocab candidates from emojilib + datamuse
// usage: node contrib/gen-emoji-vocab.ts <out.json> [cache.json]

import fs from 'node:fs'

import emojiData from 'emojilib' with { type: 'json' }

import type { EmojiVocab } from '../scripts/lib/emojiVocab.ts'
import { wordRank } from '../scripts/lib/wordRarity.ts'

import { BASIC_EMOJI } from './basicEmoji.ts'

const [, , OUT_PATH, CACHE_PATH] = process.argv
if (!OUT_PATH) throw new Error('usage: gen-emoji-vocab.ts <out.json> [cache.json]')

// emojilib is in unicode order: animals & nature .. objects
const RANGE_START = '🐵'
const RANGE_END = '🏧'
// fun extras outside that range
const EXTRA_EMOJI = ['🧟', '🧛', '🧞', '🧜', '🧚', '🧙', '🥷', '🧑‍🚀', '🦸', '🦹', '🤖', '👻', '👽', '🤡', '🎅', '🧌']

const MIN_LENGTH = 4
const COMMON_RANK = 1000
const MAX_RELATED_PER_EMOJI = 30
const MAX_SIMILAR_PER_EMOJI = 10
const MAX_EMOJI_PER_WORD = 3
const REQUEST_DELAY_MS = 100

const WORD = /^[a-z]+$/

const data = emojiData as unknown as Record<string, string[]>
const all = Object.keys(data)
const targets = [...all.slice(all.indexOf(RANGE_START), all.indexOf(RANGE_END)), ...EXTRA_EMOJI]
  .filter(emoji => data[emoji] && !BASIC_EMOJI.has(emoji))

const usable = (word: string): boolean =>
  WORD.test(word) && word.length >= MIN_LENGTH && wordRank(word) >= COMMON_RANK

// how many emojis list a keyword
const keywordSpread = new Map<string, number>()
for (const emoji of targets) for (const k of data[emoji]!) keywordSpread.set(k, (keywordSpread.get(k) ?? 0) + 1)

const names: Record<string, string> = {}
for (const emoji of targets) {
  const name = data[emoji]![0]!
  if (WORD.test(name) && name.length >= MIN_LENGTH && !names[name]) names[name] = emoji
}

// the name, else a keyword unique to this emoji; broader keywords drift off topic
const SPECIFIC_RANK = 2000
const queryFor = (emoji: string): string | undefined => {
  const [name, ...keywords] = data[emoji]!
  if (name && WORD.test(name)) return name
  return keywords.find(k => usable(k) && keywordSpread.get(k) === 1 && wordRank(k) >= SPECIFIC_RANK)
}

const cache: Record<string, string[]> = CACHE_PATH && fs.existsSync(CACHE_PATH) ? JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')) : {}

// rel_trg: strongly associated; ml: means like
const associations = async (relation: 'rel_trg' | 'ml', query: string): Promise<string[]> => {
  const key = `${relation}:${query}`
  const cached = cache[key]
  if (cached) return cached
  await new Promise(resolve => setTimeout(resolve, REQUEST_DELAY_MS))
  const response = await fetch(`https://api.datamuse.com/words?${relation}=${encodeURIComponent(query)}&max=40`)
  if (!response.ok) throw new Error(`datamuse ${response.status} for ${key}`)
  const words = ((await response.json()) as { word: string }[]).map(w => w.word)
  cache[key] = words
  return words
}

const related = new Map<string, Set<string>>()
const add = (word: string, emoji: string) => {
  const owner = names[word]
  if (owner && owner !== emoji) return
  if (!related.has(word)) related.set(word, new Set())
  related.get(word)!.add(emoji)
}

for (const emoji of targets) {
  const query = queryFor(emoji)
  const keywords = data[emoji]!.slice(1).filter(k => usable(k) && (keywordSpread.get(k) ?? 0) <= MAX_EMOJI_PER_WORD)
  const own = (w: string) => usable(w) && (!names[w] || names[w] === emoji)
  const triggers = query ? (await associations('rel_trg', query)).filter(own) : []
  const similar = query ? (await associations('ml', query)).filter(own) : []
  const picked = new Set([
    ...[...new Set([...keywords, ...triggers])].filter(own).slice(0, MAX_RELATED_PER_EMOJI),
    ...similar.slice(0, MAX_SIMILAR_PER_EMOJI)
  ])
  for (const word of picked) add(word, emoji)
}

if (CACHE_PATH) fs.writeFileSync(CACHE_PATH, JSON.stringify(cache))

const vocab: EmojiVocab = {
  names: Object.fromEntries(Object.entries(names).sort()),
  related: Object.fromEntries(
    [...related]
      .filter(([word, emojis]) => emojis.size <= MAX_EMOJI_PER_WORD && !names[word])
      .map(([word, emojis]): [string, string[]] => [word, [...emojis]])
      .sort(([a], [b]) => a.localeCompare(b))
  )
}

fs.writeFileSync(OUT_PATH, JSON.stringify(vocab, null, 1) + '\n')
console.log(`${Object.keys(vocab.names).length} names, ${Object.keys(vocab.related).length} related words`)
