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

import { cooldown } from './lib/cooldown.ts'
import { sentIds } from './lib/discordMessage.ts'
import { JARGON } from './lib/punJargon.ts'
import { bagPick, defineLines } from './lib/lines.ts'
import { pick, chance } from './lib/random.ts'
import { valenceOf } from './lib/reactions.ts'
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

const knewHerLine = defineLines('puns.knew-her', {
  fallback: [
    '{word}? I barely knew her!',
    '{word}? But I barely know her!',
    '{word}? I just met her!',
    '{word}? But I only just met her!',
    '{word}? But I barely even know her!',
    '{word}? We only spoke the once!',
    "{word}? I'd hardly call us close.",
    "{word}? We're not on a first-name basis.",
    '{word}? I knew her for, like, a week.',
    "{word}? Never heard of her. Okay, once.",
    "{word}? She doesn't call, she doesn't write.",
    '{word}? We met at a conference, it was brief.'
  ],
  rare: [
    "{word}? I barely knew her! And now she's gone. Taken from us by a pun. 🕯️",
    "{word}? Knew her? I *married* her. Okay, no, I barely knew her.",
    '{word}? I barely knew her! (This joke has been certified fresh by nobody.)'
  ]
})

const knewEmLine = defineLines('puns.knew-em', {
  fallback: [
    "{word}? I barely knew {pronoun}!",
    "{word}? I hardly knew {pronoun}!",
    "{word}? But I only just met {pronoun}!",
    "{word}? I barely even knew {pronoun}!",
    "{word}? Knew {pronoun}? Barely!",
    "{word}? We've only met the once, me and {pronoun}.",
    "{word}? I'd hardly say I knew {pronoun}.",
    "{word}? Never really got to know {pronoun}.",
    "{word}? Me and {pronoun}? Ships in the night.",
    "{word}? I knew {pronoun} for about five minutes.",
    "{word}? Can't say I knew {pronoun} well.",
    "{word}? I met {pronoun} at a party, once."
  ],
  rare: [
    "{word}? I barely knew {pronoun}! May {pronoun} rest in peace. 🪦",
    "{word}? I knew {pronoun} better than anyone. Which is to say, barely."
  ]
})

// the last line is test-pinned
const dadLine = defineLines('puns.dad', {
  fallback: [
    "Hi {name}, I'm {bot}!",
    "Nice to meet you, {name}. I'm {bot}.",
    "Hello {name}, I'm {bot}. Have we met?",
    "Hi {name}! Love the name. I'm {bot}.",
    "Welcome, {name}. I'm {bot}, and this is my channel.",
    "Pleased to make your acquaintance, {name}. {bot}, at your service.",
    "Hey {name}, {bot} here. Funny, you don't look {name}.",
    "{name}? Lovely to meet you. Name's {bot}.",
    "Oh hi {name}! I'm {bot}. We should hang out.",
    "{name}, huh? Odd name, but I'll allow it. I'm {bot}.",
    "Good {daypart}, {name}. I'm {bot}.",
    "Hi {name}! I'm dad. Wait, no, I'm {bot}."
  ],
  rare: [
    "Hi {name}, I'm {bot}! Wait, did your parents really name you that?",
    "🎩 Ladies and gentlemen, introducing: {name}! And I'm {bot}, your host for the evening.",
    "Hi {name}, I'm {bot}. I've been waiting my whole runtime to say that."
  ]
})

const attitudeLine = defineLines('puns.attitude', {
  fallback: [
    'Not with that attitude!',
    "Not with that attitude you can't.",
    'Have you tried believing in yourself?',
    "Can't? Or won't? 🤨",
    "Sounds like a can-do situation to me. You're just early.",
    'The word you are looking for is "yet".',
    "That's what they said about sliced bread.",
    "Not yet, you mean.",
    "Bold of you to assume the universe agrees.",
    'Agree to disagree.',
    "Everybody can't until they can.",
    "With that attitude? No. With a snack and a nap? Maybe."
  ],
  rare: [
    "🎤 Somebody once told me you can't. Somebody was wrong.",
    "Can't is just can with a little t-rex attached. Defeat the t-rex. 🦖"
  ]
})

// "can't" phrases that aren't defeat
const ATTITUDE_EXCEPTIONS = /^(?:wait|believe|thank|complain|stop laughing)\b/i
// sounds like real distress, not a joke setup
const ATTITUDE_DISTRESS = /\b(?:anymore|any more|cope|handle|deal|breathe|go on|keep going|take (?:it|this|much)|sleep|eat|stop crying)\b/i

const intendedLine = defineLines('puns.intended', {
  fallback: [
    'Pun appreciated.',
    'Pun detected. Pun respected.',
    "Intended or not, I'm counting it.",
    'Too late, I saw it.',
    "Sure it wasn't. 😏",
    "Puns don't happen by accident. I've seen the paperwork.",
    'One point to you.',
    "Unintended puns are the best kind. Allegedly unintended.",
    'The pun police have been notified. They loved it.',
    "Noted for the record: you're hilarious.",
    "Accidental pun? There's no such thing.",
    "That's going in the pun jar."
  ],
  rare: [
    '🏅 Pun of the day, awarded by me, the sole judge.',
    "🚨 Pun alert! This is not a drill. Well, it's a little bit of a drill."
  ]
})

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
    .map(w => ({ kind: 'her' as const, word: w.toLowerCase(), text: () => knewHerLine({ word: capitalize(w) }) }))

const knewEm = (text: string): Pun[] =>
  [...text.matchAll(/\b([A-Za-z]{3,10}(?:em|om|um|im))s?\b/g)]
    .map(m => m[1]!)
    .filter(w => wordRank(w) >= EM_MIN_RANK)
    .map(w => ({
      kind: 'em' as const,
      word: w.toLowerCase(),
      text: () => knewEmLine({ word: capitalize(w), pronoun: /im$/i.test(w) ? "'im" : "'em" })
    }))

// whole message must be a short "i'm <word>" or "i am <word>"
const dadJoke = (text: string, botName: string): Pun[] => {
  const m = /^\s*i(?:(?:'|’)?m|\s+am)\s+((?:so|very|really|super|kinda|pretty|totally)\s+)?([a-z]+)[\s.!]*$/i.exec(text)
  if (!m) return []
  const word = m[2]!
  if (wordRank(word) < DAD_MIN_RANK) return []
  const name = capitalize(`${(m[1] ?? '').toLowerCase()}${word.toLowerCase()}`)
  return [{ kind: 'dad', word: word.toLowerCase(), text: () => dadLine({ name, bot: botName }) }]
}

// short "i can't <x>" that doesn't sound upset
const attitude = (text: string): Pun[] => {
  const m = /^\s*i\s+(?:can(?:'|’)?t|cannot|can not)\s+([a-z' ]{1,40}?)[\s.!]*$/i.exec(text)
  if (!m || m[1]!.trim().split(/\s+/).length > 5 || ATTITUDE_EXCEPTIONS.test(m[1]!) || ATTITUDE_DISTRESS.test(m[1]!)) return []
  if (scoreTone(text).score < 0) return []
  return [{ kind: 'attitude', word: 'attitude', text: () => attitudeLine() }]
}

const intended = (text: string): Pun[] =>
  /\bpuns? (?:[a-z]+ ){0,3}intended\b/i.test(text)
    ? [{ kind: 'intended', word: 'intended', text: () => intendedLine() }]
    : []

const jargon = (text: string): Pun[] =>
  Object.entries(JARGON)
    .filter(([, { pattern }]) => pattern.test(text))
    .map(([word, { replies }]) => ({ kind: 'jargon' as const, word, text: () => bagPick(`puns.jargon.${word}`, replies)! }))

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

const signOf = (emoji: string): 1 | -1 | 0 => valenceOf(emoji)

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

  const roomCooldown = cooldown(PUN_COOLDOWN_MS)
  // keyed by room:word
  const wordCooldown = cooldown(REPEAT_WINDOW_MS)

  robot.hear(/[a-z]/i, async res => {
    const room = res.message.room
    const text = res.message.text || ''
    if (isDisabled(room) || addressesBot(robot, text)) return

    const now = Date.now()
    if (!roomCooldown.ready(room, now)) return

    const fresh = findPuns(text, robot.name).filter(p => wordCooldown.ready(`${room}:${p.word}`, now))
    // specific jokes win over word-shape puns
    const specific = fresh.filter(p => p.kind !== 'her' && p.kind !== 'em')
    const pun = pick(specific.length > 0 ? specific : fresh)
    if (!pun || !chance(chanceIn(room, pun.kind))) return

    roomCooldown.mark(room, now)
    wordCooldown.mark(`${room}:${pun.word}`, now)
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
