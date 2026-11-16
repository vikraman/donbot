// Description:
//   Timed focus sessions, pomodoros and tocks: work rounds with breaks in between, pinged at each change.
//   Keeps a daily focus streak.
//
// Commands:
//   hubot focus [<N> <unit>] [on <task>] - Starts one focus session, 25 minutes by default.
//   hubot pomodoro [<rounds>] [<work>/<break>[/<long break>]] [on <task>] - Work/break rounds, 25/5 with a 15m break every 4th. Runs until stopped unless you give a round count.
//   hubot tock [<rounds>] on <task> - Beeminder-style tocks: 45m on a task named up front, 15m breaks. During a break, names the next tock's task.
//   hubot distraction <note> - Parks a distracting thought for the end of the round.
//   hubot tocks - Shows your tocks today and this week; a partial tock counts as a fraction.
//   hubot skip break - Ends your break and starts the next round now.
//   hubot focus stop - Ends your session or pomodoros; a work stretch of 5+ minutes still counts.
//   hubot who's focusing - Lists people focusing or on a break, so you know when to interrupt. Tasks show only in the channel they were set in.
//   hubot focus stats - Shows your focus time this week and your streak.
//

import type { Robot, Response } from 'hubot'

import { formatDuration } from './lib/duration.ts'
import { eventsSince, logEvent } from './lib/eventLog.ts'
import type { LogEntry } from './lib/eventLog.ts'
import { mentionFor } from './lib/mention.ts'
import { defineLines } from './lib/lines.ts'
import type { LineOptions } from './lib/lines.ts'
import { postToRoom } from './lib/rooms.ts'
import { scheduler } from './lib/schedule.ts'
import type { Job } from './lib/schedule.ts'
import { getStreak, recordStreak } from './lib/streak.ts'
import { DAY_MS, dayKey, MINUTE_MS, unitMs } from './lib/time.ts'
import { userTz } from './lib/timezone.ts'

export const DEFAULT_MINUTES = 25
export const MAX_MINUTES = 4 * 60
// shorter partial sessions are not counted
export const MIN_COUNTED_MINUTES = 5
export const POMODORO = { work: 25, short: 5, long: 15, longEvery: 4 }
// https://blog.beeminder.com/tocks/
export const TOCK = { work: 45, short: 15, long: 15, longEvery: 4 }
const MAX_DISTRACTIONS = 10
// cap for open-ended pomodoros
export const MAX_ROUNDS = 16

interface Cycle {
  work: number
  short: number
  long: number
  longEvery: number
  // 0 = until stopped
  rounds: number
  round: number
  // across finished work rounds
  focused: number
  tock?: boolean
}

interface Session {
  userId: string
  room: string
  // start of the current phase
  startedAt: number
  minutes: number
  phase: 'work' | 'break'
  task?: string
  cycle?: Cycle
  distractions?: string[]
}

export interface FocusEntry extends LogEntry {
  minutes: number
  task?: string
  // fraction of a tock, for tock rounds
  tocks?: number
}

const doneLine = defineLines('focus.done', {
  fallback: [
    'Nice work. Stretch, drink some water.',
    'Solid session. Take five.',
    'That counts. Go look out a window for a bit.',
    'Done! Your brain earned a break.',
    'Focus complete. Stand up, walk around.',
    'Another block of deep work in the bank.',
    'Your future self says thanks.',
    'The task never stood a chance.',
    'Clean finish. Unclench your jaw.',
    'Excellent. The {daypart} belongs to you.',
    'That was some quality staring at a screen. The good kind.',
    'Logged, admired, filed under "things that happened".',
    'Done. Go do something with your hands for a minute.',
    'Brain: exercised. Snack: deserved.'
  ],
  rare: [
    'I watched the whole thing and I have to say, riveting stuff.',
    'Somewhere a productivity guru just felt a disturbance.',
    'If focus were a sport, this would be on the highlight reel.'
  ],
  flair: true,
  ai: { about: 'a short, warm remark after someone finishes a focused work session, ideally nudging a small break' }
})

const breakLine = defineLines('focus.break', {
  fallback: [
    'Stand up and stretch.',
    'Get some water.',
    'Look at something far away.',
    'Step away from the screen.',
    'Roll your shoulders.',
    '20-20-20: look at something 20 feet away for 20 seconds.',
    'Refill your mug. Hydration is a team sport.',
    'Stretch your wrists: palms out, gentle pull, both sides.',
    'Walk to a window and check the sky still exists.',
    'Ten slow breaths. In through the nose.',
    'Shake out your hands like you just finished a piano recital.',
    'Neck rolls, slowly, both directions.',
    'Stand up, touch your toes, or at least wave at them.',
    'Tidy one thing on your desk. Just one.'
  ],
  ai: { about: 'one concrete, specific thing to do on a short work break (stretch, water, rest the eyes, move), phrased as a friendly suggestion' }
})

const startTail = defineLines('focus.start', {
  fallback: [
    "I'll ping you when time's up.",
    "I'll keep watch and ping you at the end.",
    "Off you go, I'll shout when it's over.",
    "I'll hold your calls. Well, I'll ping you after.",
    "Phone face down. I'll ping you.",
    "Timer's running; I'll tap you on the shoulder after.",
    "Go. I'll be here counting.",
    "Notifications off, kettle optional. I'll ping you.",
    "One thing at a time. I'll ping you when it's done.",
    "Clock's ticking, quietly. I'll let you know."
  ]
})

const goLine = defineLines('focus.go', {
  fallback: ['Go!', 'Off you go.', 'Back at it.', 'Onwards.', 'Let\'s go.', 'Deep breath, then dive in.', 'Here we go again.', 'Your move.', 'Charge!', 'Eyes on the prize.', 'Fresh round, fresh start.', 'Make it count.']
})

const parkedLine = defineLines('focus.parked', {
  fallback: ['📝 Parked. Back to it.', '📝 Noted. Now, where were we?', '📝 Filed for later. Eyes front.', '📝 Got it, it can wait.', '📝 Written down, so you can stop thinking about it.', '📝 Stashed. Carry on.', '📝 Safely parked. Back to the task.', '📝 Into the later pile it goes.', '📝 Captured. Return to your regularly scheduled focus.', '📝 Out of your head, into mine.']
})

const pomodoroStreakLine = defineLines('focus.pomodoro-streak', {
  fallback: [
    '🍅🍅🍅🍅 Four in a row, {who}. That\'s a full set.',
    '🍅 Four pomodoros straight, {who}. The tomato council approves.',
    '🍅 That\'s four back to back, {who}. Long break fully earned.',
    '🍅 Quad tomato achieved, {who}.',
    '🍅 Four rounds deep, {who}. Respect.',
    '🍅 Four in a row! {who} is officially in the zone.',
    '🍅 A whole pomodoro set, {who}. Go have a proper break.',
    '🍅 Four down, {who}. That\'s nearly two hours of real work.',
    '🍅 {who} just completed the classic four. Textbook.',
    '🍅 Four pomodoros, {who}. Somewhere, a kitchen timer is proud.',
    '🍅 Set complete, {who}. Rest like you mean it.',
    '🍅 Four straight, {who}. Hydrate, stretch, bask.'
  ]
})

const tockDayLine = defineLines('focus.tock-day', {
  fallback: [
    '🕰️ {tocks} today, {who}. That\'s a full tock day.',
    '🕰️ {who} hit {tocks} today. The tock road is satisfied.',
    '🕰️ {tocks} and counting, {who}. A proper day\'s work.',
    '🕰️ Full tock day for {who}: {tocks}.',
    '🕰️ {who} has banked {tocks} today. Beeminder would be proud.',
    '🕰️ {tocks} today, {who}. Anything more is showing off.',
    '🕰️ That\'s {tocks}, {who}. Your day has structure now.',
    '🕰️ {who}: {tocks} today. Excellent tock discipline.',
    '🕰️ {tocks} in the bag, {who}.',
    '🕰️ {who} reached {tocks} today. Clocks everywhere salute you.',
    '🕰️ {tocks} today, {who}. You can coast now, guilt-free.',
    '🕰️ A {tocks} day, {who}. Write home about it.'
  ]
})

const bigWeekLine = defineLines('focus.big-week', {
  fallback: [
    '🏔️ {who} just passed 10 hours of focus this week.',
    '🏔️ Ten focused hours this week, {who}. That\'s a lot of deep work.',
    '🏔️ {who} crossed the 10-hour mark this week. Take the evening off.',
    '🏔️ Double digits! {who} has focused 10+ hours this week.',
    '🏔️ 10 hours of focus this week, {who}. Your attention span is a marvel.',
    '🏔️ {who} is past 10 focused hours this week. Absolutely unstoppable.',
    '🏔️ Ten hours, {who}. This week has been thoroughly worked.',
    '🏔️ {who} reached 10 hours of focus this week. The summit is yours.',
    '🏔️ 10+ hours this week, {who}. Rest is part of the job too.',
    '🏔️ {who}: 10 hours of focus this week. I\'m running out of superlatives.',
    '🏔️ That\'s 10 hours of deep work this week, {who}. Bravo.',
    '🏔️ {who} hit 10 focused hours this week. Celebrate responsibly.'
  ]
})

// milestones
export const POMODORO_STREAK = 4
export const TOCK_DAY = 4
export const BIG_WEEK_MINUTES = 10 * 60

const jobId = (userId: string): string => `focus:${userId}`

const taskSuffix = (task?: string): string => task ? ` on ${task}` : ''

const fmt = (minutes: number): string => formatDuration(minutes * MINUTE_MS)

const roundLabel = (cycle: Cycle): string => cycle.rounds ? `${cycle.round} of ${cycle.rounds}` : `${cycle.round}`

const unitName = (cycle: Cycle): string => cycle.tock ? 'tock' : 'round'

const isLongBreak = (cycle: Cycle): boolean => cycle.long !== cycle.short && cycle.round % cycle.longEvery === 0

export const formatTocks = (n: number): string => `${Number(n.toFixed(2))} ${n === 1 ? 'tock' : 'tocks'}`

const parked = (session: Session): string | undefined =>
  session.distractions?.length ? `📝 Parked: ${session.distractions.join('; ')}` : undefined

// "25/5", "50/10/20"
export const parseCycle = (text: string | undefined): Pick<Cycle, 'work' | 'short' | 'long'> | undefined => {
  if (!text) return { work: POMODORO.work, short: POMODORO.short, long: POMODORO.long }
  const [work, short, long] = text.split('/').map(Number)
  if (!work || !short || work > MAX_MINUTES || short > 60 || (long !== undefined && (!long || long > 60))) return undefined
  return { work, short, long: long ?? Math.max(short, Math.min(3 * short, 30)) }
}

export default async (robot: Robot) => {
  const opts = (session: Session): LineOptions => ({ room: session.room, tz: userTz(robot, session.userId) })

  const vars = (session: Session) => ({ who: mentionFor({ id: session.userId }), task: session.task ?? 'it', minutes: session.minutes })

  // streak and milestone lines for a finished stretch of work
  const logWork = (session: Session, minutes: number): string | undefined => {
    const tz = userTz(robot, session.userId)
    const mine = eventsSince<FocusEntry>(robot, 'focus', Date.now() - 7 * DAY_MS).filter(e => e.userId === session.userId)
    const today = dayKey(Date.now(), tz)
    const tocksToday = mine.filter(e => dayKey(e.ts, tz) === today).reduce((n, e) => n + (e.tocks ?? 0), 0)
    const weekMinutes = mine.reduce((n, e) => n + e.minutes, 0)
    const tocks = session.cycle?.tock ? Math.min(minutes / TOCK.work, 1) : undefined
    logEvent(robot, 'focus', { room: session.room, userId: session.userId, minutes, task: session.task, tocks })
    const extra: string[] = []
    const v = { ...vars(session), minutes }
    if (tocks && tocksToday < TOCK_DAY && tocksToday + tocks >= TOCK_DAY) extra.push(tockDayLine({ ...v, tocks: formatTocks(tocksToday + tocks) }, opts(session)))
    if (weekMinutes < BIG_WEEK_MINUTES && weekMinutes + minutes >= BIG_WEEK_MINUTES) extra.push(bigWeekLine(v, opts(session)))
    const streak = recordStreak(robot, 'focus', session.userId)
    return [...extra, streak].filter(Boolean).join('\n') || undefined
  }

  const say = async (room: string, ...lines: (string | undefined)[]) => {
    await postToRoom(robot, room, lines.filter(Boolean).join('\n'))
  }

  const sessions = scheduler<Session>(robot, 'focus', async (job: Job<Session>) => { await advance(job.data) })

  const schedule = (session: Session) => {
    sessions.add({ id: jobId(session.userId), at: session.startedAt + session.minutes * MINUTE_MS, tz: userTz(robot, session.userId), data: session })
  }

  const startBreak = (session: Session, cycle: Cycle): Session => {
    const next: Session = { ...session, phase: 'break', startedAt: Date.now(), minutes: isLongBreak(cycle) ? cycle.long : cycle.short, cycle, distractions: [] }
    schedule(next)
    return next
  }

  const startWork = (session: Session, cycle: Cycle): Session => {
    const next: Session = { ...session, phase: 'work', startedAt: Date.now(), minutes: cycle.work, cycle, distractions: [] }
    schedule(next)
    return next
  }

  const finishCycle = async (session: Session, cycle: Cycle, streak?: string) => {
    const rounds = cycle.round - (session.phase === 'break' ? 0 : 1)
    const icon = cycle.tock ? '🕰️' : '🍅'
    const count = cycle.tock ? formatTocks(cycle.focused / TOCK.work) : `${rounds} ${rounds === 1 ? 'round' : 'rounds'}`
    const done = cycle.focused
      ? `${icon} ${mentionFor({ id: session.userId })} done: ${count}, ${fmt(cycle.focused)} of focus${taskSuffix(session.task)}. ${doneLine(vars(session), opts(session))}`
      : cycle.tock ? 'Tocks stopped.' : 'Pomodoros stopped.'
    await say(session.room, done, parked(session), streak)
  }

  const advance = async (session: Session) => {
    const cycle = session.cycle
    if (!cycle) {
      const streak = logWork(session, session.minutes)
      await say(session.room, `⏰ ${mentionFor({ id: session.userId })} ${fmt(session.minutes)} of focus${taskSuffix(session.task)} done. ${doneLine(vars(session), opts(session))}`, parked(session), streak)
      return
    }
    if (session.phase === 'work') {
      const streak = logWork(session, session.minutes)
      const next = { ...cycle, focused: cycle.focused + session.minutes }
      const limit = cycle.rounds || MAX_ROUNDS
      if (cycle.round >= limit) {
        await finishCycle({ ...session, phase: 'break' }, next, streak)
        return
      }
      const brk = startBreak(session, next)
      const kind = isLongBreak(next) ? 'long break' : 'break'
      const icon = cycle.tock ? '🕰️' : '🍅'
      const hint = cycle.tock ? `Next tock stays on ${session.task}; \`tock on <task>\` changes it.` : undefined
      const set = !cycle.tock && cycle.round % POMODORO_STREAK === 0 ? pomodoroStreakLine(vars(session), opts(session)) : undefined
      await say(session.room, `${icon} ${mentionFor({ id: session.userId })} ${unitName(cycle)} ${roundLabel(cycle)} done. ☕ ${fmt(brk.minutes)} ${kind}: ${breakLine(vars(session), opts(session))}`, set, parked(session), hint, streak)
      return
    }
    const next = startWork(session, { ...cycle, round: cycle.round + 1 })
    const label = cycle.tock ? 'Tock' : 'Round'
    await say(session.room, `⏰ ${mentionFor({ id: session.userId })} break's over. ${label} ${roundLabel(next.cycle!)}, ${fmt(next.minutes)}${taskSuffix(session.task)}. ${goLine(vars(next), opts(next))}`)
  }

  const busy = async (res: Response): Promise<boolean> => {
    const existing = sessions.get(jobId(res.message.user.id))
    if (!existing) return false
    const left = formatDuration(existing.at - Date.now(), { round: Math.ceil })
    await res.send(`You're already ${existing.data.phase === 'break' ? 'on a break' : 'focusing'}, ${left} to go. \`focus stop\` ends it.`)
    return true
  }

  const start = async (res: Response, amount: string | undefined, unit: string | undefined, task: string | undefined) => {
    const userId = res.message.user.id
    let minutes = DEFAULT_MINUTES
    if (amount) {
      const size = unitMs(unit || 'minutes')
      if (!size || size < MINUTE_MS) {
        await res.send(`I don't understand "${amount} ${unit}". Try \`focus 25m\` or \`focus 1 hour\`.`)
        return
      }
      minutes = Math.round(Number(amount) * size / MINUTE_MS)
    }
    if (minutes < 1 || minutes > MAX_MINUTES) {
      await res.send(`Pick something between 1 minute and ${MAX_MINUTES / 60} hours.`)
      return
    }
    if (await busy(res)) return
    const session: Session = { userId, room: res.message.room, startedAt: Date.now(), minutes, phase: 'work', task: task?.trim() || undefined }
    schedule(session)
    await res.send(`🎯 Focusing for ${fmt(minutes)}${taskSuffix(session.task)}. ${startTail(vars(session), opts(session))}`)
  }

  robot.respond(/tock(?: (\d+)(?: tocks?)?)?(?: on (.+))?$/i, async res => {
    const userId = res.message.user.id
    const task = res.match[2]?.trim()
    const job = sessions.get(jobId(userId))
    // during a tock break, names the next tock
    if (job && job.data.cycle?.tock && job.data.phase === 'break' && task && !res.match[1]) {
      sessions.add({ ...job, data: { ...job.data, task } })
      await res.send(`Next tock: ${task}.`)
      return
    }
    if (!task) {
      await res.send('Tocks start with a task, decided up front: `tock on <task>`.')
      return
    }
    const rounds = res.match[1] ? Number(res.match[1]) : 0
    if (rounds > MAX_ROUNDS) {
      await res.send(`Up to ${MAX_ROUNDS} tocks at a time.`)
      return
    }
    if (await busy(res)) return
    const cycle: Cycle = { ...TOCK, rounds, round: 1, focused: 0, tock: true }
    startWork({ userId, room: res.message.room, startedAt: Date.now(), minutes: cycle.work, phase: 'work', task }, cycle)
    const plan = rounds ? `${rounds} ${rounds === 1 ? 'tock' : 'tocks'}` : 'until you stop'
    const session = sessions.get(jobId(userId))!.data
    await res.send(`🕰️ Tock on ${task}: 45m, then a 15m break, ${plan}. \`distraction <note>\` parks stray thoughts. ${goLine(vars(session), opts(session))}`)
  })

  robot.respond(/distraction:? (.+)$/i, async res => {
    const job = sessions.get(jobId(res.message.user.id))
    if (!job || job.data.phase !== 'work') {
      await res.send('Only while focusing. Write it down and get back to it later!')
      return
    }
    const distractions = [...(job.data.distractions ?? []), res.match[1]!.trim()].slice(-MAX_DISTRACTIONS)
    sessions.add({ ...job, data: { ...job.data, distractions } })
    await res.send(parkedLine(vars(job.data), opts(job.data)))
  })

  robot.respond(/tocks$/i, async res => {
    const userId = res.message.user.id
    const tz = userTz(robot, userId)
    const mine = eventsSince<FocusEntry>(robot, 'focus', Date.now() - 7 * DAY_MS).filter(e => e.userId === userId && e.tocks)
    const today = dayKey(Date.now(), tz)
    const sum = (entries: FocusEntry[]) => entries.reduce((n, e) => n + (e.tocks ?? 0), 0)
    if (mine.length === 0) {
      await res.send('No tocks in the last 7 days. `tock on <task>` starts one.')
      return
    }
    await res.send(`${formatTocks(sum(mine.filter(e => dayKey(e.ts, tz) === today)))} today, ${formatTocks(sum(mine))} in the last 7 days.`)
  })

  robot.respond(/pomodoro(?: (\d+)(?: rounds?)?)?(?: (\d+\/\d+(?:\/\d+)?))?(?: on (.+))?$/i, async res => {
    const rounds = res.match[1] ? Number(res.match[1]) : 0
    const lengths = parseCycle(res.match[2])
    if (!lengths || rounds > MAX_ROUNDS) {
      await res.send(`Try \`pomodoro\`, \`pomodoro 4\` or \`pomodoro 4 50/10\` (work/break minutes, up to ${MAX_ROUNDS} rounds).`)
      return
    }
    if (await busy(res)) return
    const cycle: Cycle = { ...lengths, longEvery: POMODORO.longEvery, rounds, round: 1, focused: 0 }
    const task = res.match[3]?.trim() || undefined
    startWork({ userId: res.message.user.id, room: res.message.room, startedAt: Date.now(), minutes: cycle.work, phase: 'work', task }, cycle)
    const plan = rounds ? `${rounds} ${rounds === 1 ? 'round' : 'rounds'}` : 'until you stop'
    await res.send(`🍅 Pomodoros${taskSuffix(task)}: ${cycle.work}m work, ${cycle.short}m breaks, ${cycle.long}m every ${cycle.longEvery}th, ${plan}. Round 1, go!`)
  })

  robot.respond(/skip(?: the)? break$/i, async res => {
    const job = sessions.get(jobId(res.message.user.id))
    if (!job || job.data.phase !== 'break') {
      await res.send("You're not on a break.")
      return
    }
    sessions.remove(job.id)
    await advance(job.data)
  })

  robot.respond(/focus stop$|(?:stop|done) focusing$|(?:pomodoro|tock) stop$|stop (?:pomodoros?|tocks?)$/i, async res => {
    const job = sessions.get(jobId(res.message.user.id))
    if (!job) {
      await res.send("You're not in a focus session.")
      return
    }
    sessions.remove(job.id)
    const session = job.data
    const worked = session.phase === 'work' ? Math.floor((Date.now() - session.startedAt) / MINUTE_MS) : 0
    const counted = worked >= MIN_COUNTED_MINUTES ? worked : 0
    const streak = counted ? logWork(session, counted) : undefined
    if (session.cycle) {
      await finishCycle(session, { ...session.cycle, focused: session.cycle.focused + counted }, streak)
      return
    }
    if (!counted) {
      await res.send('Focus session cancelled.')
      return
    }
    await say(session.room, `${mentionFor({ id: session.userId })} stopped after ${fmt(counted)}${taskSuffix(session.task)}. Still counts.`, parked(session), streak)
  })

  robot.respond(/who(?:'s| is) focusing\??$/i, async res => {
    const active = sessions.list()
    if (active.length === 0) {
      await res.send('Nobody is focusing right now.')
      return
    }
    const lines = active.map(j => {
      const left = formatDuration(j.at - Date.now(), { round: Math.ceil })
      const who = mentionFor({ id: j.data.userId })
      if (j.data.phase === 'break') return `${who} on a break, ${left} left ☕`
      const round = j.data.cycle ? ` (${unitName(j.data.cycle)} ${roundLabel(j.data.cycle)})` : ''
      // tasks stay in the channel or dm they were set in
      const task = j.data.room === res.message.room ? taskSuffix(j.data.task) : ''
      return `${who}${task}${round}, ${left} left`
    })
    await res.send(`🤫 Focusing now:\n${lines.join('\n')}`)
  })

  robot.respond(/focus stats$/i, async res => {
    const userId = res.message.user.id
    const mine = eventsSince<FocusEntry>(robot, 'focus', Date.now() - 7 * DAY_MS).filter(e => e.userId === userId)
    const total = mine.reduce((sum, e) => sum + e.minutes, 0)
    const streak = getStreak(robot, 'focus', userId)
    const streakText = streak && streak.current > 0 ? ` You're on a ${streak.current}-day streak (best ${streak.best}).` : ''
    if (total === 0) {
      await res.send(`No focus sessions in the last 7 days.${streakText} \`focus\` starts one.`)
      return
    }
    const tocks = mine.reduce((n, e) => n + (e.tocks ?? 0), 0)
    const tockText = tocks ? `, ${formatTocks(tocks)}` : ''
    await res.send(`${fmt(total)} of focus over ${mine.length} ${mine.length === 1 ? 'session' : 'sessions'}${tockText} in the last 7 days.${streakText}`)
  })

  robot.respond(/focus(?: (\d+)\s*([a-z]+)?)?(?: on (.+))?$/i, async res => {
    await start(res, res.match[1], res.match[2], res.match[3])
  })
}
