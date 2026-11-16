// Description:
//   A weekly recap of the channel: kudos, wins, focus time, standups, GitHub, chat activity and running streaks.
//
// Commands:
//   hubot recap - Posts the last 7 days' recap now.
//   hubot recap on [every <day> at <time>] - (Owner only) Posts it automatically, Fridays at 4pm by default.
//   hubot recap off - (Owner only) Stops the automatic recap.
//   hubot recap status - Shows when the next recap is due.
//
// Configuration:
//   OWNER_USER_ID - Discord user ID allowed to turn the recap on or off.
//

import type { Robot } from 'hubot'

import { formatDuration } from './lib/duration.ts'
import { eventsSince } from './lib/eventLog.ts'
import type { LogEntry } from './lib/eventLog.ts'
import { defineLines } from './lib/lines.ts'
import { userForGithubLogin } from './lib/githubUsers.ts'
import { mentionFor } from './lib/mention.ts'
import { isOwner, OWNER_ONLY } from './lib/owner.ts'
import { postToRoom } from './lib/rooms.ts'
import { scheduler } from './lib/schedule.ts'
import { getStreak, STREAK_KINDS, streakLabel, streakPeriod } from './lib/streak.ts'
import { DAY_MS, describeRepeat, formatWhen, MINUTE_MS, parseWhen } from './lib/time.ts'
import { defaultTz, tzNote, userTz } from './lib/timezone.ts'

const WEEK_MS = 7 * DAY_MS
const DEFAULT_SCHEDULE = 'every friday at 4pm'

interface KudosEntry extends LogEntry { target: string, targetId?: string, reason?: string, delta: number }
interface FocusEntry extends LogEntry { minutes: number }
interface WinEntry extends LogEntry { text: string }
interface GithubEntry extends LogEntry { repo: string, kind: string, item?: string, actor?: string, title?: string }
interface HistoryEntry { ts: number, kind: string, authorId?: string }

const closer = defineLines('recap.closer', {
  fallback: [
    'Great week, everyone. Rest up. 🌴',
    'Proud of this crew. Have a good weekend! 🍻',
    'That\'s a wrap. See you next week. 👋',
    'Onwards! 🚀',
    'Nice work all round. 💚',
    'Another week in the books. The books are getting heavy. 📚',
    'Go touch some grass. You\'ve earned it. 🌿',
    'Same time next week? Same time next week. 🗓️',
    'Weekend mode: engaged. 🛋️',
    'A fine week. I\'d frame it if I had walls. 🖼️',
    'Thank you for your service, humans. 🫡',
    'Logging off from this week. Back on Monday with fresh opinions. 🤖',
    'Recharge those batteries. Mine are fine, I\'m a bot. 🔋',
    'Ship it, rest, repeat. ♻️'
  ],
  rare: [
    'This recap was brought to you by caffeine, stubbornness, and all of you. 🫶',
    'I ran the numbers. Conclusion: you lot are alright. 📊',
    'Fun fact: this was the best week of the year so far. I say that every week. I mean it every week. 💫',
    'End of transmission. Beep boop, have a lovely weekend. 📡'
  ],
  ai: { about: 'a warm, funny one-line sign-off for a team\'s weekly recap message, usually sent on a Friday afternoon' }
})

const quietWeek = defineLines('recap.quiet', {
  fallback: {
    open: [
      '📰 Weekly recap: a quiet week here.',
      '📰 Weekly recap: a quiet week. Suspiciously quiet.',
      '📰 Weekly recap: quiet week. The tumbleweeds send their regards.',
      '📰 Weekly recap: a quiet week, so I\'ve been polishing my circuits.'
    ],
    body: [
      'Log a `win` or give some `kudos` next week!',
      'Next week, try a `win` or two. Small ones count.',
      'Somebody deserves `kudos`. You know who you are. Actually, you know who they are.',
      'A `focus` session or a `standup:` check-in would give me something to brag about.'
    ]
  }
})

// earned highlights, posted above the closer
const bigFocus = defineLines('recap.bigFocus', {
  fallback: [
    '🧠 Over {hours} hours of focus this week. Brains: fully deployed.',
    '🧠 {hours}+ hours of deep work. Somebody check the room for scorch marks.',
    '🧠 {hours} hours of focus! The distractions never stood a chance.'
  ]
})
const winStorm = defineLines('recap.winStorm', {
  fallback: [
    '🌪️ {wins} wins in one week. That\'s not a week, that\'s a highlight reel.',
    '🌪️ A storm of {wins} wins this week. Please wear protective gear.',
    '🌪️ {wins} wins! I may need a bigger trophy shelf.'
  ]
})
const perfectStandup = defineLines('recap.perfectStandup', {
  fallback: [
    '💯 Perfect standup attendance: everyone checked in. Gold stars all round.',
    '💯 Every single person checked in to standup. I\'m not crying, you\'re crying.',
    '💯 Full house at standup this week. Organisational excellence, achieved.'
  ]
})

export const BIG_FOCUS_HOURS = 10
export const WIN_STORM = 10

interface StandupRound { checkIns?: { userId: string }[], expected?: string[] }

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

// key -> count, descending
const tally = <T>(items: T[], keyOf: (item: T) => string | undefined, weight: (item: T) => number = () => 1): [string, number][] => {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = keyOf(item)
    if (key) counts.set(key, (counts.get(key) ?? 0) + weight(item))
  }
  return [...counts].sort((a, b) => b[1] - a[1])
}

// running streaks shown in the recap
export const MIN_RECAP_STREAK = 3
const MAX_RECAP_STREAKS = 5

export const buildRecap = (robot: Robot, room: string, now = Date.now(), tz = defaultTz()): string => {
  const since = now - WEEK_MS
  const sections: string[] = []
  const highlights: string[] = []
  const opts = { room, tz }

  const kudos = eventsSince<KudosEntry>(robot, 'kudos', since, room).filter(k => k.delta > 0)
  const people = kudos.filter(k => k.targetId)
  if (kudos.length) {
    const top = tally(people, k => k.targetId).slice(0, 3).map(([id, n]) => `${mentionFor({ id })} (${n})`)
    const reasons = people.filter(k => k.reason).slice(-3).map(k => `  “${k.reason}” → ${mentionFor({ id: k.targetId })}`)
    sections.push([`💛 ${plural(kudos.length, 'kudo')} given${top.length ? `, most to ${top.join(', ')}` : ''}.`, ...reasons].join('\n'))
  }

  const wins = eventsSince<WinEntry>(robot, 'win', since, room)
  if (wins.length) {
    const shown = wins.slice(-5).map(w => `  • ${mentionFor({ id: w.userId })}: ${w.text}`)
    if (wins.length >= WIN_STORM) highlights.push(winStorm({ wins: wins.length }, opts))
    sections.push([`🏆 ${plural(wins.length, 'win')} logged:`, ...shown, ...(wins.length > 5 ? [`  …and ${wins.length - 5} more`] : [])].join('\n'))
  }

  const focus = eventsSince<FocusEntry>(robot, 'focus', since, room)
  if (focus.length) {
    const total = focus.reduce((sum, f) => sum + f.minutes, 0)
    const [topId, topMinutes] = tally(focus, f => f.userId, f => f.minutes)[0] ?? []
    const champ = topId ? `, longest by ${mentionFor({ id: topId })} (${formatDuration((topMinutes ?? 0) * MINUTE_MS)})` : ''
    if (total >= BIG_FOCUS_HOURS * 60) highlights.push(bigFocus({ hours: Math.floor(total / 60) }, opts))
    sections.push(`🎯 ${formatDuration(total * MINUTE_MS)} of focus in ${plural(focus.length, 'session')}${champ}.`)
  }

  const standups = eventsSince(robot, 'standup', since, room)
  if (standups.length) {
    const people = new Set(standups.map(s => s.userId)).size
    const round = robot.brain.get<StandupRound>(`standup:round:${room}`)
    const expected = round?.expected ?? []
    const checked = new Set((round?.checkIns ?? []).map(c => c.userId))
    if (expected.length > 1 && expected.every(id => checked.has(id))) highlights.push(perfectStandup({}, opts))
    sections.push(`📋 ${plural(standups.length, 'standup check-in')} from ${plural(people, 'person').replace('persons', 'people')}.`)
  }

  const github = eventsSince<GithubEntry>(robot, 'github', since, room)
  if (github.length) {
    const count = (kind: string, item?: string) => github.filter(g => g.kind === kind && (!item || g.item === item)).length
    const parts = [
      count('merged') && plural(count('merged'), 'PR') + ' merged',
      count('release') && plural(count('release'), 'release'),
      count('closed', 'issue') && plural(count('closed', 'issue'), 'issue') + ' closed',
      count('ci-fixed') && `CI rescued ${count('ci-fixed')}×`
    ].filter(Boolean)
    const contributors = tally(github.filter(g => g.kind === 'merged'), g => g.actor).slice(0, 3).map(([a]) => a)
    if (parts.length) sections.push(`🐙 ${parts.join(', ')}${contributors.length ? `. Thanks ${contributors.join(', ')}!` : '.'}`)
  }

  const history = robot.brain.get<HistoryEntry[]>(`history:${room}`)
  const messages = Array.isArray(history) ? history.filter(h => h.kind === 'user-message' && h.ts >= since) : []
  if (messages.length) {
    const [chattiest] = tally(messages, h => h.authorId)
    sections.push(`💬 ${plural(messages.length, 'message')}${chattiest ? `, most from ${mentionFor({ id: chattiest[0] })}` : ''}.`)
  }

  // streaks are global, so only people seen in this room this week
  const active = new Set<string>([
    ...kudos.flatMap(k => [k.userId, k.targetId]),
    ...wins.map(w => w.userId),
    ...focus.map(f => f.userId),
    ...standups.map(s => s.userId),
    ...messages.map(m => m.authorId),
    ...github.map(g => g.actor && userForGithubLogin(robot, g.actor))
  ].filter((id): id is string => Boolean(id)))
  const streaks = [...active].flatMap(userId => STREAK_KINDS.map(kind => ({ userId, kind, current: getStreak(robot, kind, userId, now)?.current ?? 0 })))
    .filter(s => s.current >= MIN_RECAP_STREAK)
    // weeks outrank days
    .sort((a, b) => b.current * (streakPeriod(b.kind) === 'week' ? 7 : 1) - a.current * (streakPeriod(a.kind) === 'week' ? 7 : 1))
    .slice(0, MAX_RECAP_STREAKS)
  if (streaks.length) {
    sections.push(`🔥 Streaks going: ${streaks.map(s => `${mentionFor({ id: s.userId })} ${s.current}-${streakPeriod(s.kind)} ${streakLabel(s.kind)}`).join(', ')}.`)
  }

  if (sections.length === 0) return quietWeek({}, opts)
  return `📰 **Weekly recap**\n\n${[...sections, ...highlights].join('\n\n')}\n\n${closer({}, opts)}`
}

interface RecapJob { room: string }

export default async (robot: Robot) => {
  const recaps = scheduler<RecapJob>(robot, 'recap', async job => {
    await postToRoom(robot, job.data.room, buildRecap(robot, job.data.room, Date.now(), job.tz))
  }, { missedGraceMs: DAY_MS })

  const jobId = (room: string): string => `recap:${room}`

  robot.respond(/recap on(?: (every .+))?$/i, async res => {
    if (!isOwner(res)) {
      await res.send(OWNER_ONLY)
      return
    }
    const room = res.message.room
    const tz = userTz(robot, res.message.user.id)
    const when = parseWhen(res.match[1] || DEFAULT_SCHEDULE, tz)
    if (!when?.repeat || when.repeat.kind !== 'weekly') {
      await res.send('Try `recap on every friday at 4pm`.')
      return
    }
    recaps.add({ id: jobId(room), at: when.at, tz, repeat: when.repeat, data: { room } })
    await res.send(`Weekly recap on, ${describeRepeat(when.repeat)}${tzNote(tz)}. First one ${formatWhen(when.at, tz)}.`)
  })

  robot.respond(/recap off$/i, async res => {
    if (!isOwner(res)) {
      await res.send(OWNER_ONLY)
      return
    }
    const removed = recaps.remove(jobId(res.message.room))
    await res.send(removed ? 'Weekly recap off for this channel.' : 'This channel has no recap scheduled.')
  })

  robot.respond(/recap status$/i, async res => {
    const job = recaps.get(jobId(res.message.room))
    await res.send(job?.repeat
      ? `Recap runs ${describeRepeat(job.repeat)}${tzNote(job.tz)}, next ${formatWhen(job.at, job.tz)}.`
      : `No recap scheduled. \`${robot.name} recap on\` posts one every Friday at 4pm.`)
  })

  robot.respond(/(?:weekly )?recap(?: week)?$/i, async res => {
    await res.send(buildRecap(robot, res.message.room, Date.now(), userTz(robot, res.message.user.id)))
  })
}
