// Description:
//   Points for things, kudos with reasons for people, and leaderboards.
//
// Commands:
//   <thing>++ [for <reason>] - Gives <thing> a point, optionally saying why.
//   <thing>-- [for <reason>] - Takes a point from <thing>.
//   @<user>++ [for <reason>] - Gives a person a point (no points for yourself).
//   hubot kudos <user> [for <reason>] - Gives <user> kudos (a point) and says why.
//   hubot kudos for <user> - Shows the latest reasons <user> got kudos.
//   hubot reasons for <thing> - Shows the latest reasons <thing> got or lost points.
//   hubot score for <thing|user> - Shows points for <thing> or <user>.
//   hubot leaderboard - Shows the top 10 scores.
//   hubot leaderboard people - Shows the top 10 people.
//   hubot leaderboard things - Shows the top 10 things.
//   hubot leaderboard week - Shows who gained the most points in the last 7 days.
//
// Each user can change a score once every 5 minutes, and at most 5 scores a minute;
// votes past either limit are ignored. Things are 1-3 words with ++/-- attached ("c++" isn't
// a vote for c); a thing back at 0 with no reasons is forgotten, and at most 500 are tracked.
//

import type { Robot, Response } from 'hubot'

import { entriesWithPrefix, isScore, scoreAt } from './lib/brainScan.ts'
import { burst, cooldown } from './lib/cooldown.ts'
import { formatAgo } from './lib/duration.ts'
import { eventsSince, logEvent } from './lib/eventLog.ts'
import type { LogEntry } from './lib/eventLog.ts'
import { defineLines } from './lib/lines.ts'
import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { chance } from './lib/random.ts'
import { DAY_MS } from './lib/time.ts'
import { userTz } from './lib/timezone.ts'

const PREFIX = 'plusplus:'
const USER_PREFIX = 'user:'
const REASONS_PREFIX = 'kudos:reasons:'

// per user per target
export const VOTE_COOLDOWN_MS = 5 * 60 * 1000
// per user, across targets
export const MAX_VOTES_PER_WINDOW = 5
export const VOTE_WINDOW_MS = 60 * 1000

const MAX_REASONS = 20
const MAX_REASON_LENGTH = 200
// keeps the brain from filling with one-off things
export const MAX_THINGS = 500
const MAX_THING_LENGTH = 40
const MAX_THING_WORDS = 3
const SHOWN_REASONS = 5
const TOP_N = 10
const COMMENT_CHANCE = 0.5

const kudosAck = defineLines('kudos.ack', {
  fallback: [
    '🎉 Kudos to {who} for {reason}!',
    '👏 {who} gets kudos for {reason}.',
    '🙌 Nice one, {who}: {reason}. People noticed.',
    '✨ {reason}? That was {who}. Take a bow.',
    '💚 Kudos, {who}, for {reason}. Keep it up!',
    '🏅 Official recognition for {who}: {reason}. I made a little medal in my head.',
    '📣 Hear ye: {who} did {reason}, and it was good.',
    '🌟 {who}, {reason} did not go unnoticed. Nothing goes unnoticed. I see everything.',
    '🧁 A virtual cupcake for {who}, for {reason}.',
    '🎺 *tiny trumpet noises* for {who}: {reason}.',
    '🫡 Respect to {who} for {reason}.',
    '🍀 {who} brought the good stuff: {reason}.',
    '📜 Let the record show: {who}, {reason}, excellent.',
    '🥇 {reason}. Gold star, {who}.'
  ],
  rare: [
    '🏆 Breaking news: {who} has been awarded the Order of the Rubber Duck for {reason}.',
    '🎆 The council of bots has convened and agrees: {who} absolutely nailed {reason}.',
    '🦄 A wild unicorn appears to congratulate {who} on {reason}. It leaves glitter everywhere.',
    '📯 I have commissioned a ballad about {who} and {reason}. It is mostly kazoo.'
  ],
  flair: true,
  ai: { about: 'thanking a teammate with kudos for a specific thing they did', slots: ['who', 'reason'] }
})

const kudosPlain = defineLines('kudos.plain', {
  fallback: [
    '🎉 Kudos to {who}!',
    '👏 {who} gets kudos.',
    '🙌 Nice one, {who}!',
    '✨ {who}, people noticed.',
    '💚 Kudos, {who}. Keep it up!',
    '🌟 A shiny point for {who}.',
    '🫡 Respect, {who}.',
    '🧁 One virtual cupcake for {who}.',
    '🎺 *tiny trumpet noises* for {who}.',
    '📣 Everyone, look at {who}. Approvingly.',
    '🍀 {who} is having a good {daypart}.',
    '🏅 {who}, consider yourself medalled.'
  ],
  rare: [
    '🏆 {who} has been inducted into the Hall of Mild Fame.',
    '🦄 A unicorn wandered by to high-five {who}. You missed it. It was majestic.',
    '📯 Somewhere, a tiny brass band plays for {who}.'
  ],
  flair: true,
  ai: { about: 'giving a teammate kudos, no reason given', slots: ['who'] }
})

// a person's score just hit a round number
const kudosMilestone = defineLines('kudos.milestone', {
  fallback: [
    '🎊 That makes {score} points for {who}. A milestone!',
    '🎊 {who} just hit {score}. Somebody get the confetti cannon.',
    '🎊 {score} points, {who}. You\'re basically a local legend now.',
    '🎊 Point number {score} for {who}. I\'m having a plaque made.'
  ]
})

export const KUDOS_MILESTONES = [10, 25, 50, 100, 250, 500, 1000] as const

const selfKudos = defineLines('kudos.self', {
  fallback: [
    "Nice try, but you can't give yourself points.",
    'Self-five noted. No points, though.',
    "I admire the confidence, but that's not how this works.",
    'Points have to come from someone else. Go be awesome at someone.',
    'Bold move. Rejected, but bold.',
    'The point economy does not accept self-dealing.',
    "You can't tip yourself, friend.",
    'I checked with the committee. The committee is me. The answer is no.',
    'That\'s a lovely thought. Have someone else think it about you.',
    'Points are like compliments: weird if you give them to yourself.',
    'Denied. But I believe in you, for what it\'s worth (zero points).',
    'Self-kudos detected. Initiating gentle disapproval.'
  ],
  rare: [
    '🚨 Self-kudos alarm triggered. Deploying the Committee of Raised Eyebrows.',
    'I have forwarded your request to my supervisor. My supervisor is also me. Still no.',
    'In some parallel universe this worked. Not this one.'
  ],
  ai: { about: 'gently refusing when someone tries to give themselves kudos points' }
})

const topComment = defineLines('kudos.top', {
  fallback: [
    '{who} is untouchable right now.',
    'All hail {who}.',
    "Nobody's catching {who} at this rate.",
    '{who} really is built different.',
    '{who} sits atop the mountain, slightly smug.',
    'The view from the top looks good on {who}.',
    '{who}: still the one to beat.',
    'Crown fits, {who}.',
    'Someone check {who} for performance-enhancing snacks.',
    '{who} is speedrunning this leaderboard.',
    'Long live {who}.',
    '{who} has a comfortable lead and knows it.'
  ],
  rare: ['{who} has achieved leaderboard enlightenment. The rest of you are merely scores.']
})

const bottomComment = defineLines('kudos.bottom', {
  fallback: [
    '{who} is really struggling down here.',
    'Rough day for {who}.',
    '{who} needs some love.',
    'Someone go check on {who}.',
    '{who}: plenty of room to grow.',
    'Every leaderboard needs a {who}. Thank you for your service.',
    '{who} is playing the long game.',
    'Underdog season for {who}.',
    '{who} is just warming up. Probably.',
    'Bottom of the table, top of our hearts: {who}.',
    'A point for {who}, anyone? Anyone?',
    '{who} is keeping things humble down here.'
  ],
  rare: ['{who} is not last, {who} is just first from the bottom.']
})

interface Target {
  // brain key suffix: `user:<id>` or the lowercased thing
  key: string
  display: string
  userId?: string
}

interface Reason {
  reason: string
  by: string
  ts: number
  delta: number
}

interface KudosLog extends LogEntry {
  ts: number
  target: string
  targetId?: string
  delta: number
}

const isReason = (value: unknown): value is Reason =>
  typeof value === 'object' && value !== null && typeof (value as Reason).reason === 'string' && typeof (value as Reason).ts === 'number'

const personTarget = (id: string): Target => ({ key: `${USER_PREFIX}${id}`, display: mentionFor({ id }), userId: id })

const thingTarget = (thing: string): Target => ({ key: thing.toLowerCase(), display: thing })

// <@id>, @name (fuzzy) or an exact known name -> person; else a thing
const resolveTarget = (robot: Robot, raw: string): Target | undefined => {
  const text = raw.trim()
  const mention = text.match(/^<@!?(\d+)>$/)
  if (mention) return personTarget(required(mention, 1))
  if (text.startsWith('@')) {
    const users = robot.brain.usersForFuzzyName(text.slice(1))
    const sole = users.length === 1 ? users[0] : undefined
    return sole ? personTarget(sole.id) : undefined
  }
  const exact = Object.values(robot.brain.data.users || {}).filter(u => u.name && u.name.toLowerCase() === text.toLowerCase())
  const sole = exact.length === 1 ? exact[0] : undefined
  return sole ? personTarget(sole.id) : thingTarget(text)
}

const displayFor = (key: string): string =>
  key.startsWith(USER_PREFIX) ? mentionFor({ id: key.slice(USER_PREFIX.length) }) : key

const readReasons = (robot: Robot, key: string): Reason[] => {
  const stored = robot.brain.get(REASONS_PREFIX + key)
  return Array.isArray(stored) ? stored.filter(isReason) : []
}

const formatLeaderboard = (rows: { who: string, score: number }[], room?: string): string => {
  const lines = rows.map((r, i) => `${i + 1}. ${r.who}: ${r.score}`)
  const top = rows[0]
  const bottom = rows[rows.length - 1]
  if (top && chance(COMMENT_CHANCE)) lines.push('', topComment({ who: top.who }, { room }))
  if (bottom && rows.length > 1 && chance(COMMENT_CHANCE)) lines.push(bottomComment({ who: bottom.who }, { room }))
  return lines.join('\n')
}

const TARGET = String.raw`(<@!?\d+>|@?[\w .-]+?)`
// people may have a space before ++; things need it attached, so "ok --" isn't a vote
const VOTE = new RegExp(String.raw`^\s*(?:(<@!?\d+>|@[\w .-]+?)\s*|([\w.-](?:[\w .-]*[\w.-])?))(\+\+|--)(?:\s+for\s+(.+?))?\s*$`)

// "c++", "i--" and "I love c++" aren't votes for c
const plausibleThing = (thing: string): boolean => {
  const words = thing.split(/\s+/)
  const last = words[words.length - 1]!
  return thing.length <= MAX_THING_LENGTH && words.length <= MAX_THING_WORDS && last.length >= 2 && !/^\d+$/.test(last)
}

export default async (robot: Robot) => {
  const voteCooldown = cooldown(VOTE_COOLDOWN_MS)
  const voteBurst = burst(MAX_VOTES_PER_WINDOW, VOTE_WINDOW_MS)

  // new score, or why nothing changed; replies to self-votes only
  const vote = async (res: Response, target: Target, delta: number, reason?: string): Promise<number | 'limited' | 'self'> => {
    const voter = res.message.user.id
    if (target.userId === voter && delta > 0) {
      await res.send(selfKudos({}, { room: res.message.room, tz: userTz(robot, voter) }))
      return 'self'
    }
    const isNewThing = !target.userId && robot.brain.get(PREFIX + target.key) === null
    if (isNewThing && entriesWithPrefix(robot, PREFIX, isScore).filter(([key]) => !key.startsWith(USER_PREFIX)).length >= MAX_THINGS) return 'limited'
    const voteKey = `${voter}:${target.key}`
    if (!voteCooldown.ready(voteKey) || !voteBurst.take(voter)) return 'limited'
    voteCooldown.mark(voteKey)

    const score = scoreAt(robot, PREFIX + target.key) + delta
    if (reason) {
      const reasons = [...readReasons(robot, target.key), { reason: reason.slice(0, MAX_REASON_LENGTH), by: voter, ts: Date.now(), delta }]
      robot.brain.set(REASONS_PREFIX + target.key, reasons.slice(-MAX_REASONS))
    }
    // a thing back at zero with nothing to say for it is forgotten
    if (score === 0 && !target.userId && readReasons(robot, target.key).length === 0) robot.brain.remove(PREFIX + target.key)
    else robot.brain.set(PREFIX + target.key, score)
    logEvent(robot, 'kudos', { room: res.message.room, userId: voter, target: target.display, targetId: target.userId, reason, delta })
    return score
  }

  robot.hear(VOTE, async res => {
    const target = resolveTarget(robot, res.match[1] ?? required(res.match, 2))
    if (!target || (!target.userId && !plausibleThing(target.display))) return
    const delta = required(res.match, 3) === '++' ? 1 : -1
    const reason = res.match[4]?.trim()
    const score = await vote(res, target, delta, reason)
    if (typeof score !== 'number') return
    await res.send(`${target.display}: ${score}${reason ? ` (for ${reason})` : ''}`)
  })

  robot.respond(/kudos (?!for )(.+?)(?: for (.+?))?\s*$/i, async res => {
    const who = required(res.match, 1).trim()
    const target = resolveTarget(robot, who)
    if (!target || !target.userId) {
      await res.send(`I don't know who ${who} is. Try mentioning them.`)
      return
    }
    const reason = res.match[2]?.trim()
    const score = await vote(res, target, 1, reason)
    if (score === 'self') return
    if (score === 'limited') {
      await res.send(`You just gave ${target.display} a point. Give it a few minutes.`)
      return
    }
    const opts = { room: res.message.room, tz: userTz(robot, res.message.user.id) }
    const ack = reason ? kudosAck({ who: target.display, reason }, opts) : kudosPlain({ who: target.display }, opts)
    const milestone = (KUDOS_MILESTONES as readonly number[]).includes(score) ? `\n${kudosMilestone({ who: target.display, score }, opts)}` : ''
    await res.send(`${ack} (score: ${score})${milestone}`)
  })

  robot.respond(new RegExp(String.raw`(?:kudos|reasons) for ${TARGET}\??\s*$`, 'i'), async res => {
    const raw = required(res.match, 1)
    const target = resolveTarget(robot, raw)
    if (!target) {
      await res.send(`I don't know who ${raw.trim()} is.`)
      return
    }
    const reasons = readReasons(robot, target.key).slice(-SHOWN_REASONS).reverse()
    if (reasons.length === 0) {
      await res.send(`No reasons recorded for ${target.display} yet.`)
      return
    }
    const lines = reasons.map(r => `• ${r.delta < 0 ? '(−) ' : ''}${r.reason} — from ${mentionFor({ id: r.by })}, ${formatAgo(r.ts)}`)
    await res.send([`Why ${target.display} has points:`, ...lines].join('\n'))
  })

  robot.respond(new RegExp(String.raw`(?:score for|points for|how many points does) ${TARGET} ?(?:have)?\??\s*$`, 'i'), async res => {
    const raw = required(res.match, 1)
    const target = resolveTarget(robot, raw)
    if (!target) {
      await res.send(`I don't know who ${raw.trim()} is.`)
      return
    }
    await res.send(`${target.display}: ${scoreAt(robot, PREFIX + target.key)}`)
  })

  robot.respond(/(?:leaderboard|top scores|high scores|rankings)(?: (people|things|week))?$/i, async res => {
    const scope = res.match[1]?.toLowerCase()

    if (scope === 'week') {
      const gains = new Map<string, { who: string, score: number }>()
      for (const e of eventsSince<KudosLog>(robot, 'kudos', Date.now() - 7 * DAY_MS)) {
        if (typeof e.delta !== 'number' || typeof e.target !== 'string') continue
        const key = e.targetId ? `${USER_PREFIX}${e.targetId}` : e.target.toLowerCase()
        const row = gains.get(key) ?? { who: e.targetId ? mentionFor({ id: e.targetId }) : e.target, score: 0 }
        row.score += e.delta
        gains.set(key, row)
      }
      const rows = [...gains.values()].filter(r => r.score !== 0).sort((a, b) => b.score - a.score).slice(0, TOP_N)
      await res.send(rows.length === 0 ? 'No points changed hands this week.' : `This week:\n${formatLeaderboard(rows, res.message.room)}`)
      return
    }

    const rows = entriesWithPrefix(robot, PREFIX, isScore)
      .filter(([key]) => scope === 'people' ? key.startsWith(USER_PREFIX) : scope === 'things' ? !key.startsWith(USER_PREFIX) : true)
      .map(([key, score]) => ({ who: displayFor(key), score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, TOP_N)
    await res.send(rows.length === 0 ? 'No scores yet.' : formatLeaderboard(rows, res.message.room))
  })
}
