// Description:
//   Async weekly standups. The bot asks at a set time, people check in with DONE / NEXT /
//   BLOCKERS / DISCUSS whenever suits them, and a summary follows (a day later by default) with
//   blockers and topics rolled up. A round stays open until the next prompt, so late check-ins still count.
//   Shortly before the summary, it pings last round's people who haven't checked in yet.
//
// Commands:
//   hubot standup every <days> at <time> [, summary after <N> <unit>] - Schedules this channel's standup, e.g. "every monday at 10am" or "every friday at 2pm, summary after 3 hours".
//   hubot standup off - Stops this channel's standup.
//   hubot standup - Shows the schedule and who has checked in this round.
//   hubot standup summary - Shows this round's summary now.
//   standup: DONE: <..> NEXT: <..> BLOCKERS: <..> DISCUSS: <..> - Checks in, one section per line or inline. Re-posting replaces your check-in.
//
// The schedule uses the timezone of whoever set it (see `my timezone is`). Streaks count weeks.
//

import type { Robot, Response } from 'hubot'

import { formatDuration } from './lib/duration.ts'
import { logEvent } from './lib/eventLog.ts'
import { defineLines } from './lib/lines.ts'
import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { scheduler } from './lib/schedule.ts'
import { recordStreak } from './lib/streak.ts'
import { DAY_MS, describeRepeat, formatWhen, HOUR_MS, MINUTE_MS, parseWhen, unitMs } from './lib/time.ts'
import { tzNote, userTz } from './lib/timezone.ts'

export const SUMMARY_DELAY_MS = DAY_MS
const MIN_SUMMARY_DELAY_MS = 15 * MINUTE_MS
const MAX_SUMMARY_DELAY_MS = 6 * DAY_MS
// ping for missing check-ins this long before the summary, or halfway for short rounds
export const REMINDER_LEAD_MS = 2 * HOUR_MS
// rounds without a schedule start over after this
export const ADHOC_ROUND_MS = 7 * DAY_MS
const MAX_LENGTH = 1000

interface CheckIn {
  userId: string
  text: string
  ts: number
}

// from one prompt to the next
interface Round {
  startedAt: number
  checkIns: CheckIn[]
  summarized?: boolean
  // ad-hoc rounds start at the first check-in, not a prompt
  prompted?: boolean
  // last round's people, pinged if they haven't checked in
  expected?: string[]
}

interface StandupJob {
  room: string
  summaryMs?: number
}

const roundKey = (room: string): string => `standup:round:${room}`
// pre-round daily state
const LEGACY_DAY_PREFIX = 'standup:day:'

const prompt = defineLines('standup.prompt', {
  fallback: [
    '📋 Weekly standup!',
    '☕ Standup time, how did the week go?',
    '🗓️ Weekly check-in.',
    '📋 It\'s standup o\'clock.',
    '🛰️ Weekly status ping. Report in, crew.',
    '🧭 Time to look back and look ahead.',
    '📬 The weekly standup has arrived. No stamp required.',
    '🔔 Ding! Standup time.',
    '🧾 Weekly receipts, please: what got done, what\'s next.',
    '🌤️ Happy {weekday}! Standup time.',
    '🗞️ Hot off the press: it\'s standup.',
    '🎙️ The floor is yours. Weekly standup.'
  ],
  rare: [
    '🦉 The Standup Owl has landed. It demands updates. It accepts snacks.',
    '📜 By ancient decree, the weekly standup is now in session.',
    '🛸 Greetings, earthlings. Please report your weekly progress to the mothership.'
  ],
  ai: { about: 'a short opener announcing the team\'s weekly async standup check-in' }
})

const thanks = defineLines('standup.thanks', {
  fallback: [
    '✅ Thanks {who}!',
    '✅ Got it, {who}.',
    '✅ Noted, {who}.',
    '✅ Filed under "excellent", {who}.',
    '✅ Thanks for checking in, {who}.',
    '✅ Received loud and clear, {who}.',
    '✅ {who} has reported for duty.',
    '✅ Logged, {who}. Very professional.',
    '✅ Cheers, {who}.',
    '✅ That\'s the stuff, {who}.',
    '✅ One more for the summary. Thanks, {who}.',
    '✅ Appreciated, {who}.'
  ],
  rare: ['✅ {who}, your check-in has been laminated and framed.', '✅ {who} checked in faster than I could say "standup". Impressive.']
})

const reminder = defineLines('standup.reminder', {
  fallback: [
    '⏰ Standup summary{when}. Still waiting on {missing}',
    '⏰ Summary goes out{when}. Haven\'t heard from {missing} yet',
    '⏰ Last call for standup! Summary{when}. Missing: {missing}',
    '⏰ {missing}: the standup misses you. Summary{when}'
  ]
})

const emptyRound = defineLines('standup.empty', {
  fallback: [
    '📋 Standup summary: nobody checked in this round.',
    '📋 Standup summary: crickets this round. 🦗',
    '📋 Standup summary: zero check-ins. Everyone must be very, very busy.'
  ]
})

export const SECTIONS = ['done', 'next', 'blockers', 'discuss'] as const
export type Section = typeof SECTIONS[number]
export type Report = Partial<Record<Section, string>>

const TEMPLATE = '```\nstandup:\nDONE: what you finished\nNEXT: what you\'re on next\nBLOCKERS: anything in your way\nDISCUSS: anything to talk through\n```'

const ALIASES: Record<string, Section> = {
  done: 'done', did: 'done', shipped: 'done', yesterday: 'done',
  next: 'next', today: 'next', doing: 'next', todo: 'next', plan: 'next', planned: 'next',
  blocker: 'blockers', blockers: 'blockers', blocked: 'blockers', blocking: 'blockers', stuck: 'blockers',
  discuss: 'discuss', discussion: 'discuss', question: 'discuss', questions: 'discuss', topics: 'discuss'
}

// labels need a colon, so "did x" or "blocked on y" mid-sentence isn't a section
const LABEL = new RegExp(`(?:^|(?<=[\\s/;|]))(${Object.keys(ALIASES).join('|')})\\s*:\\s*`, 'gi')

// "none", "n/a", "-" mean nothing to report
const EMPTY = /^(?:no(?:ne|thing|pe)?(?: (?:yet|really))?|n\/?a|nada|nil|-+|—)[.!]*$/i

const clean = (text: string): string => text.replace(/[\s/;|]+$/, '').replace(/\s*\n\s*/g, ' ').trim()

// text before the first label counts as done
export const parseReport = (text: string): Report => {
  const report: Report = {}
  const marks = [...text.matchAll(LABEL)]
  const add = (section: Section, value: string) => {
    const v = clean(value)
    if (!v || EMPTY.test(v)) return
    report[section] = report[section] ? `${report[section]}; ${v}` : v
  }
  add('done', text.slice(0, marks[0]?.index ?? text.length))
  marks.forEach((m, i) => {
    add(ALIASES[m[1]!.toLowerCase()]!, text.slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length))
  })
  return report
}

export default async (robot: Robot) => {
  const readRound = (room: string): Round | undefined => {
    const stored = robot.brain.get(roundKey(room))
    return typeof stored === 'object' && stored !== null && Array.isArray((stored as Round).checkIns) ? stored as Round : undefined
  }

  robot.brain.on('loaded', () => {
    for (const key of Object.keys(robot.brain.data._private || {})) {
      if (key.startsWith(LEGACY_DAY_PREFIX)) robot.brain.remove(key)
    }
  })

  const summaryText = (round: Round, room: string): string => {
    if (round.checkIns.length === 0) return emptyRound({}, { room })
    const reports = round.checkIns.map(c => [mentionFor({ id: c.userId }), parseReport(c.text)] as const)
    const people = reports.map(([who, r]) =>
      [who, `  **DONE:** ${r.done ?? '—'}`, `  **NEXT:** ${r.next ?? '—'}`].join('\n'))
    const rollup = (section: Section) => reports.filter(([, r]) => r[section]).map(([who, r]) => `• ${who}: ${r[section]}`)
    const blockers = rollup('blockers')
    const discuss = rollup('discuss')
    const count = round.checkIns.length
    return [
      `📋 Standup summary (${count} ${count === 1 ? 'check-in' : 'check-ins'})`,
      people.join('\n'),
      blockers.length ? `🚧 **BLOCKERS**\n${blockers.join('\n')}` : '🚧 No blockers. 🎉',
      ...(discuss.length ? [`💬 **DISCUSS**\n${discuss.join('\n')}`] : [])
    ].join('\n\n')
  }

  const summarize = async (room: string) => {
    const round = readRound(room)
    if (!round || round.summarized) return
    robot.brain.set(roundKey(room), { ...round, summarized: true })
    await robot.messageRoom(room, summaryText(round, room))
  }

  const summaries = scheduler<StandupJob>(robot, 'standup-summary', async job => { await summarize(job.data.room) })

  const reminders = scheduler<StandupJob>(robot, 'standup-reminder', async job => {
    const room = job.data.room
    const round = readRound(room)
    if (!round || round.summarized) return
    const checked = new Set(round.checkIns.map(c => c.userId))
    const missing = (round.expected ?? []).filter(id => !checked.has(id))
    if (missing.length === 0) return
    const summary = summaries.get(`summary:${room}`)
    const when = summary ? ` in ${formatDuration(summary.at - Date.now(), { round: Math.ceil })}` : ' soon'
    const nag = reminder({ when, missing: missing.map(id => mentionFor({ id })).join(', ') }, { room, tz: job.tz })
    await robot.messageRoom(room, `${nag}: \`standup: DONE: … NEXT: …\``)
  })

  const prompts = scheduler<StandupJob>(robot, 'standup', async job => {
    const room = job.data.room
    // a summary that never went out (bot down, or ad-hoc round) goes first
    const previous = readRound(room)
    if (previous && !previous.summarized && previous.checkIns.length > 0) await summarize(room)
    const expected = previous ? [...new Set(previous.checkIns.map(c => c.userId))] : []
    robot.brain.set(roundKey(room), { startedAt: Date.now(), checkIns: [], prompted: true, expected } satisfies Round)
    const delay = job.data.summaryMs ?? SUMMARY_DELAY_MS
    summaries.add({ id: `summary:${room}`, at: Date.now() + delay, tz: job.tz, data: { room } })
    if (expected.length) {
      reminders.add({ id: `reminder:${room}`, at: Date.now() + delay - Math.min(REMINDER_LEAD_MS, delay / 2), tz: job.tz, data: { room } })
    }
    await robot.messageRoom(room, `${prompt({}, { room, tz: job.tz })} Check in any time, summary ${formatWhen(Date.now() + delay, job.tz)}. Reply with:\n${TEMPLATE}`)
  })

  const promptId = (room: string): string => `standup:${room}`

  robot.respond(/standup (every .+?)(?:,? (?:and )?summary (?:after|in) (\d+) ?([a-z]+))?$/i, async res => {
    const room = res.message.room
    const tz = userTz(robot, res.message.user.id)
    const when = parseWhen(required(res.match, 1), tz)
    if (!when?.repeat || when.repeat.kind !== 'weekly') {
      await res.send('Try something like `standup every monday at 10am` or `standup every friday at 2pm, summary after 3 hours`.')
      return
    }
    let summaryMs = SUMMARY_DELAY_MS
    if (res.match[2]) {
      summaryMs = Number(res.match[2]) * (unitMs(res.match[3]!) ?? NaN)
      if (!(summaryMs >= MIN_SUMMARY_DELAY_MS && summaryMs <= MAX_SUMMARY_DELAY_MS)) {
        await res.send('The summary can come between 15 minutes and 6 days after the prompt.')
        return
      }
    }
    prompts.add({ id: promptId(room), at: when.at, tz, repeat: when.repeat, data: { room, summaryMs } })
    await res.send(`Standup set for ${describeRepeat(when.repeat)}${tzNote(tz)}, summary ${formatDuration(summaryMs)} later. First one is ${formatWhen(when.at, tz)}.`)
  })

  robot.respond(/standup off$/i, async res => {
    const room = res.message.room
    const removed = prompts.remove(promptId(room))
    summaries.remove(`summary:${room}`)
    reminders.remove(`reminder:${room}`)
    await res.send(removed ? 'Standup stopped for this channel.' : 'This channel has no standup scheduled.')
  })

  robot.respond(/standup$/i, async res => {
    const room = res.message.room
    const job = prompts.get(promptId(room))
    const round = readRound(room)
    const schedule = job?.repeat
      ? `Standup runs ${describeRepeat(job.repeat)}${tzNote(job.tz)}, next ${formatWhen(job.at, job.tz)}.`
      : `No standup scheduled here. \`${robot.name} standup every monday at 10am\` sets one up.`
    const pending = summaries.get(`summary:${room}`)
    const due = pending && !round?.summarized ? ` Summary ${formatWhen(pending.at, pending.tz)}.` : ''
    const checked = round ? round.checkIns.map(c => mentionFor({ id: c.userId })) : []
    const so = round ? ` ${checked.length} checked in this round${checked.length ? `: ${checked.join(', ')}` : ''}.` : ''
    await res.send(`${schedule}${so}${due}`)
  })

  robot.respond(/standup summary$/i, async res => {
    const round = readRound(res.message.room)
    if (!round) {
      await res.send('No standup has run here yet.')
      return
    }
    await res.send(summaryText(round, res.message.room))
  })

  const checkIn = async (res: Response, text: string) => {
    const report = parseReport(text)
    if (!report.done && !report.next && !report.blockers && !report.discuss) {
      await res.send(`Use the four sections, e.g.\n${TEMPLATE}`)
      return
    }
    const room = res.message.room
    const userId = res.message.user.id
    const existing = readRound(room)
    const stale = existing && !existing.prompted && Date.now() - existing.startedAt > ADHOC_ROUND_MS
    const round: Round = existing && !stale ? existing : { startedAt: Date.now(), checkIns: [] }
    const replacing = round.checkIns.some(c => c.userId === userId)
    const checkIns = [...round.checkIns.filter(c => c.userId !== userId), { userId, text: text.slice(0, MAX_LENGTH), ts: Date.now() }]
    robot.brain.set(roundKey(room), { ...round, checkIns })
    const late = round.summarized ? ' The summary already went out; `standup summary` shows it with yours.' : ''
    if (replacing) {
      await res.send(`Updated your check-in.${late}`)
      return
    }
    logEvent(robot, 'standup', { room, userId })
    const streak = recordStreak(robot, 'standup', userId)
    const missing = (['done', 'next'] as const).filter(s => !report[s]).map(s => s.toUpperCase())
    const notes = [
      report.blockers && 'Sorry about the blocker, it\'ll be in the summary.',
      report.discuss && 'Added to the discussion list.',
      missing.length && `No ${missing.join(' or ')}? Re-post to add it.`
    ].filter(Boolean).join(' ')
    const thank = thanks({ who: mentionFor({ id: userId, name: res.message.user.name }) }, { room, tz: userTz(robot, userId) })
    await res.send(`${thank}${notes ? ` ${notes}` : ''}${late}${streak ? `\n${streak}` : ''}`)
  }

  robot.hear(/^\s*standup:\s*([\s\S]+)$/i, async res => {
    await checkIn(res, required(res.match, 1).trim())
  })

  // addressed form; the hear above only matches unaddressed text
  robot.respond(/standup:\s*([\s\S]+)$/i, async res => {
    await checkIn(res, required(res.match, 1).trim())
  })
}
