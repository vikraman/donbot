// Description:
//   Occasionally answers with a pun: "Functor? I barely knew her!", "Theorem? I barely knew 'em!",
//   "I'm hungry" -> "Hi Hungry, I'm donbot!", "I can't" -> "Not with that attitude!", replies to
//   "no pun intended", and math/programming in-jokes. At most one pun per channel every so often.
//   Like (😂 👍) or dislike (🙄 👎) reactions on a pun make that kind of pun more or less likely in the channel.
//
// Commands:
//   hubot puns - show whether puns are on in this channel, and how likely each kind is
//   hubot puns off - turn puns off in this channel
//   hubot puns on - turn puns back on in this channel
//

import type { Robot, DiscordReaction, DiscordUser } from 'hubot'

import { JARGON } from './lib/punJargon.ts'
import { pick, chance } from './lib/random.ts'
import { addressesBot, roomToggle } from './lib/roomToggle.ts'
import { scoreTone } from './lib/sentiment.ts'
import { isRareWord, wordRank } from './lib/wordRarity.ts'

// starting chance, before any feedback
export const PUN_CHANCE = 0.314
export const MIN_CHANCE = 0.07
export const MAX_CHANCE = 0.6
// chance multiplier at fully positive feedback; inverse at fully negative
const FEEDBACK_SPREAD = 5
// feedback weight of an imaginary neutral pun history, so one vote can't swing it
const FEEDBACK_PRIOR = 2
export const FEEDBACK_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000
const FEEDBACK_MAX_AGE_MS = 8 * FEEDBACK_HALF_LIFE_MS
const MAX_RECORDS = 200
// quiet period per channel after a pun
export const PUN_COOLDOWN_MS = 30 * 60 * 1000
// same word not punned again in a channel within this window
export const REPEAT_WINDOW_MS = 24 * 60 * 60 * 1000

// 'em puns allow mid-frequency words like theorem
const EM_MIN_RANK = 4000
const DAD_MIN_RANK = 2000

const DISABLED_KEY = 'puns:disabled'
const SENT_KEY = 'puns:sent'

export const LIKE_EMOJI = new Set([
  '😂', '🤣', '😆', '😹', '😄', '😁', '😅', '💀', '🥁', '👍', '❤️', '🔥', '💯', '👏', '🙌'
])
export const DISLIKE_EMOJI = new Set([
  '👎', '🙄', '😒', '😑', '😐', '🤦', '🤦‍♂️', '🤦‍♀️', '🍅', '🫤', '😬', '🤢', '🤮', '😴'
])

export type PunKind = 'her' | 'em' | 'dad' | 'attitude' | 'intended' | 'jargon'

const KIND_LABEL: Record<PunKind, string> = {
  her: 'knew-her',
  em: "knew-'em",
  dad: 'dad jokes',
  attitude: 'attitude',
  intended: 'pun intended',
  jargon: 'in-jokes'
}

interface PunRecord {
  id: string
  room: string
  kind: PunKind
  at: number
  // user id -> +1 like, -1 dislike
  votes: Record<string, 1 | -1>
}

const KNEW_HER = [
  'I barely knew her!',
  'But I barely know her!',
  'I just met her!',
  'But I only just met her!',
  'But I barely even know her!'
] as const

const KNEW_EM = [
  'I barely knew {}!',
  'I hardly knew {}!',
  'But I only just met {}!'
] as const

// {} is the name, {bot} the bot
const DAD = [
  "Hi {}, I'm {bot}!",
  "Nice to meet you, {}. I'm {bot}.",
  "Hello {}, I'm {bot}. Have we met?",
  "Hi {}! I'm dad. Wait, no, I'm {bot}."
] as const

const ATTITUDE = [
  'Not with that attitude!',
  "Not with that attitude you can't.",
  'Have you tried believing in yourself?'
] as const

// "can't" phrases that aren't defeat
const ATTITUDE_EXCEPTIONS = /^(?:wait|believe|thank|complain|stop laughing)\b/i
// sounds like real distress, not a joke setup
const ATTITUDE_DISTRESS = /\b(?:anymore|any more|cope|handle|deal|breathe|go on|keep going|take (?:it|this|much)|sleep|eat|stop crying)\b/i

const INTENDED = [
  'Pun appreciated.',
  'Pun detected. Pun respected.',
  "Intended or not, I'm counting it.",
  'Too late, I saw it.'
] as const

export interface Pun {
  kind: PunKind
  // lowercased word, for repeat suppression
  word: string
  // lazy so unused candidates don't draw randomness
  text: () => string
}

const capitalize = (word: string): string => word.slice(0, 1).toUpperCase() + word.slice(1).toLowerCase()

// code, links and discord tokens aren't conversation
const prose = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>\s]*>/g, ' ')

const knewHer = (text: string): Pun[] =>
  [...text.matchAll(/\b([A-Za-z]{4,9}(?:or|er))s?\b/g)]
    .map(m => m[1]!)
    .filter(isRareWord)
    .map(w => ({ kind: 'her' as const, word: w.toLowerCase(), text: () => `${capitalize(w)}? ${pick(KNEW_HER)}` }))

const knewEm = (text: string): Pun[] =>
  [...text.matchAll(/\b([A-Za-z]{3,10}(?:em|om|um|im))s?\b/g)]
    .map(m => m[1]!)
    .filter(w => wordRank(w) >= EM_MIN_RANK)
    .map(w => ({
      kind: 'em' as const,
      word: w.toLowerCase(),
      text: () => `${capitalize(w)}? ${pick(KNEW_EM).replace('{}', /im$/i.test(w) ? "'im" : "'em")}`
    }))

// whole message must be a short "i'm <word>" or "i am <word>"
const dadJoke = (text: string, botName: string): Pun[] => {
  const m = /^\s*i(?:(?:'|’)?m|\s+am)\s+((?:so|very|really|super|kinda|pretty|totally)\s+)?([a-z]+)[\s.!]*$/i.exec(text)
  if (!m) return []
  const word = m[2]!
  if (wordRank(word) < DAD_MIN_RANK) return []
  const name = capitalize(`${(m[1] ?? '').toLowerCase()}${word.toLowerCase()}`)
  return [{ kind: 'dad', word: word.toLowerCase(), text: () => pick(DAD).replace('{}', name).replace('{bot}', botName) }]
}

// short "i can't <x>" that doesn't sound upset
const attitude = (text: string): Pun[] => {
  const m = /^\s*i\s+(?:can(?:'|’)?t|cannot|can not)\s+([a-z' ]{1,40}?)[\s.!]*$/i.exec(text)
  if (!m || m[1]!.trim().split(/\s+/).length > 5 || ATTITUDE_EXCEPTIONS.test(m[1]!) || ATTITUDE_DISTRESS.test(m[1]!)) return []
  if (scoreTone(text).score < 0) return []
  return [{ kind: 'attitude', word: 'attitude', text: () => pick(ATTITUDE) }]
}

const intended = (text: string): Pun[] =>
  /\bpuns? (?:[a-z]+ ){0,3}intended\b/i.test(text)
    ? [{ kind: 'intended', word: 'intended', text: () => pick(INTENDED) }]
    : []

const jargon = (text: string): Pun[] =>
  Object.entries(JARGON)
    .filter(([, { pattern }]) => pattern.test(text))
    .map(([word, { replies }]) => ({ kind: 'jargon' as const, word, text: () => pick(replies) }))

// every pun the message allows
export const findPuns = (text: string, botName: string): Pun[] => {
  const clean = prose(text)
  return [...dadJoke(clean, botName), ...attitude(clean), ...intended(clean), ...jargon(clean), ...knewHer(clean), ...knewEm(clean)]
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x))

const isRecord = (value: unknown): value is PunRecord =>
  typeof value === 'object' && value !== null &&
  typeof (value as PunRecord).id === 'string' && typeof (value as PunRecord).room === 'string' &&
  typeof (value as PunRecord).at === 'number' && typeof (value as PunRecord).votes === 'object'

const readRecords = (robot: Robot): PunRecord[] => {
  const stored = robot.brain.get(SENT_KEY)
  return Array.isArray(stored) ? stored.filter(isRecord) : []
}

// one pun's verdict in [-1, 1]; two net votes is a full verdict
const verdict = (record: PunRecord): number =>
  clamp(Object.values(record.votes).reduce<number>((a, b) => a + b, 0), -2, 2) / 2

// decayed average verdict for a room and kind, shrunk toward neutral
export const feedbackFor = (records: readonly PunRecord[], room: string, kind: PunKind, now: number): number => {
  let total = 0
  let weights = 0
  for (const r of records) {
    if (r.room !== room || r.kind !== kind) continue
    const weight = 0.5 ** ((now - r.at) / FEEDBACK_HALF_LIFE_MS)
    total += weight * verdict(r)
    weights += weight
  }
  return total / (FEEDBACK_PRIOR + weights)
}

export const chanceFor = (feedback: number): number =>
  clamp(PUN_CHANCE * FEEDBACK_SPREAD ** feedback, MIN_CHANCE, MAX_CHANCE)

const sentIds = (sent: unknown): string[] =>
  Array.isArray(sent) ? sent.map(m => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string') : []

const signOf = (emoji: string): 1 | -1 | 0 => LIKE_EMOJI.has(emoji) ? 1 : DISLIKE_EMOJI.has(emoji) ? -1 : 0

export default async (robot: Robot) => {
  const chanceIn = (room: string, kind: PunKind): number =>
    chanceFor(feedbackFor(readRecords(robot), room, kind, Date.now()))

  const details = (room: string): string =>
    'Chance per pun: ' + (Object.keys(KIND_LABEL) as PunKind[])
      .map(kind => `${KIND_LABEL[kind]} ${Math.round(chanceIn(room, kind) * 100)}%`).join(', ') + '.'

  const { isDisabled } = roomToggle(robot, { command: 'puns', brainKey: DISABLED_KEY, label: 'Puns', details })

  const remember = (ids: string[], room: string, kind: PunKind, now: number) => {
    if (ids.length === 0) return
    const fresh = readRecords(robot).filter(r => now - r.at < FEEDBACK_MAX_AGE_MS)
    const added = ids.map(id => ({ id, room, kind, at: now, votes: {} }))
    robot.brain.set(SENT_KEY, [...fresh, ...added].slice(-MAX_RECORDS))
  }

  // adding sets the user's vote; removing withdraws it if the sign matches
  const vote = (messageId: string, userId: string, sign: 1 | -1, add: boolean) => {
    const records = readRecords(robot)
    const record = records.find(r => r.id === messageId)
    if (!record) return
    if (add) record.votes[userId] = sign
    else if (record.votes[userId] === sign) delete record.votes[userId]
    else return
    robot.brain.set(SENT_KEY, records)
  }

  // room -> last pun at
  const lastPun = new Map<string, number>()
  // room -> word -> punned at
  const punned = new Map<string, Map<string, number>>()

  robot.hear(/[a-z]/i, async res => {
    const room = res.message.room
    const text = res.message.text || ''
    if (isDisabled(room) || addressesBot(robot, text)) return

    const now = Date.now()
    if (now - (lastPun.get(room) ?? -Infinity) < PUN_COOLDOWN_MS) return

    const words = punned.get(room) ?? new Map<string, number>()
    for (const [w, ts] of words) if (now - ts >= REPEAT_WINDOW_MS) words.delete(w)
    punned.set(room, words)

    const fresh = findPuns(text, robot.name).filter(p => !words.has(p.word))
    // specific jokes win over word-shape puns
    const specific = fresh.filter(p => p.kind !== 'her' && p.kind !== 'em')
    const pun = pick(specific.length > 0 ? specific : fresh)
    if (!pun || !chance(chanceIn(room, pun.kind))) return

    lastPun.set(room, now)
    words.set(pun.word, now)
    remember(sentIds(await res.send(pun.text())), room, pun.kind, now)
  })

  const client = robot.adapter && robot.adapter.client
  if (!client || typeof client.on !== 'function') return

  // partial reactions still carry the emoji and message id
  const onReaction = (add: boolean) => (reaction: DiscordReaction, user: DiscordUser) => {
    if (user.bot) return
    const sign = signOf(reaction.emoji.name)
    if (sign === 0 || !reaction.message?.id) return
    vote(reaction.message.id, user.id, sign, add)
  }
  client.on('messageReactionAdd', onReaction(true))
  client.on('messageReactionRemove', onReaction(false))
}
