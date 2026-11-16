// Description:
//   Set one-off or recurring reminders for yourself or someone else. Times use your timezone
//   (see `hubot my timezone is`). Persists in the brain, survives restarts.
//
// Commands:
//   hubot remind me <when> to <message> - Reminds you, e.g. in 10 minutes, at 3pm, tomorrow at 9, on friday at 10:30.
//   hubot remind me to <message> <when> - Same, time last.
//   hubot remind <user> <when> to <message> - Reminds <user> instead.
//   hubot remind me every <weekday|day|monday,...> at <time> to <message> - Recurring reminder, e.g. every weekday at 9am.
//   hubot remind me every <N> hours to <message> - Recurring reminder on an interval.
//   hubot list reminders - Shows pending reminders in this room, numbered.
//   hubot my reminders - Shows your pending reminders in this room.
//   hubot cancel reminder <n> - Cancels reminder <n> from the list.
//

import type { Robot, Response } from 'hubot'

import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { postToRoom } from './lib/rooms.ts'
import { scheduler } from './lib/schedule.ts'
import type { Job } from './lib/schedule.ts'
import { describeRepeat, formatWhen, HOUR_MS, parseWhen } from './lib/time.ts'
import type { When } from './lib/time.ts'
import { tzNote, userTz } from './lib/timezone.ts'

const LEGACY_KEY = 'reminders'

// keep one person, or one channel, from burying everyone in reminders
export const MAX_PER_PERSON = 25
export const MAX_PER_ROOM = 100
export const MIN_OTHERS_INTERVAL_MS = HOUR_MS
const MAX_MESSAGE_LENGTH = 500

interface Reminder {
  targetId?: string
  targetName: string
  room: string
  message: string
  byId?: string
}

interface LegacyReminder {
  id: string
  targetId?: string
  targetName: string
  room: string
  message: string
  dueAt: number
}

const EXAMPLES = 'Try `in 10 minutes`, `at 3pm`, `tomorrow at 9am`, `on friday at 10:30`, `every weekday at 9am` or `every 2 hours`.'

const mentionOf = (r: Reminder): string => mentionFor({ id: r.targetId, name: r.targetName })

interface Target {
  id?: string
  name: string
}

// "me" is the sender; else look up in brain
const resolveTarget = (robot: Robot, res: Response, who: string): Target => {
  const trimmed = who.trim()
  if (!trimmed || trimmed.toLowerCase() === 'me') {
    return { id: res.message.user.id, name: res.message.user.name }
  }

  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/)
  if (mentionMatch) {
    const mentionedId = required(mentionMatch, 1)
    const user = robot.brain.userForId(mentionedId)
    return { id: mentionedId, name: (user && user.name) || trimmed }
  }

  const name = trimmed.replace(/^@/, '')
  const users = robot.brain.usersForFuzzyName(name)
  const sole = users.length === 1 ? users[0] : undefined
  return sole ? { id: sole.id, name: sole.name } : { name }
}

interface Parsed {
  when: When
  whenText: string
  message: string
}

// "to <msg> <when>" or "<when> to <msg>"; first split parseWhen accepts wins
export const parseRequest = (body: string, tz: string, now = Date.now()): Parsed | undefined => {
  const text = body.trim()
  const toFirst = text.match(/^to (.+)$/i)
  if (toFirst) {
    const rest = required(toFirst, 1)
    const words = rest.split(' ')
    for (let i = 1; i < words.length; i++) {
      const whenText = words.slice(i).join(' ')
      const when = parseWhen(whenText, tz, now)
      if (when) return { when, whenText, message: words.slice(0, i).join(' ') }
    }
  }
  const re = / to /gi
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const whenText = text.slice(0, m.index)
    const when = parseWhen(whenText, tz, now)
    const message = text.slice(m.index + m[0].length).trim()
    if (when && message) return { when, whenText, message }
  }
  return undefined
}

const describeWhen = (when: When, whenText: string, tz: string): string => {
  if (when.repeat?.kind === 'interval') return describeRepeat(when.repeat)
  if (when.repeat) return `${describeRepeat(when.repeat)}${tzNote(tz)}`
  if (/^\s*in /i.test(whenText)) return whenText.trim().toLowerCase()
  return `${formatWhen(when.at, tz)}${tzNote(tz)}`
}

const roomJobs = (jobs: Job<Reminder>[], room: string): Job<Reminder>[] =>
  jobs.filter(j => j.data.room === room).sort((a, b) => a.at - b.at)

const listLine = (job: Job<Reminder>, n: number): string => {
  const due = formatWhen(job.at, job.tz)
  const repeat = job.repeat ? `, ${describeRepeat(job.repeat)}` : ''
  return `${n}. ${due}${repeat} for ${mentionOf(job.data)}: ${job.data.message}`
}

export default async (robot: Robot) => {
  const reminders = scheduler<Reminder>(robot, 'remind', async job => {
    await postToRoom(robot, job.data.room, `${mentionOf(job.data)} reminder: ${job.data.message}`)
  })

  // pre-scheduler reminders
  robot.brain.on('connected', () => {
    const legacy = robot.brain.get<LegacyReminder[]>(LEGACY_KEY)
    if (!Array.isArray(legacy)) return
    for (const r of legacy) {
      if (typeof r?.dueAt !== 'number') continue
      reminders.add({ id: r.id, at: r.dueAt, tz: userTz(robot, r.targetId), data: { targetId: r.targetId, targetName: r.targetName, room: r.room, message: r.message } })
    }
    robot.brain.remove(LEGACY_KEY)
  })

  const handleList = async (res: Response, mineOnly: boolean) => {
    const requester = res.message.user.id
    const lines = roomJobs(reminders.list(), res.message.room)
      .map((job, i) => ({ job, n: i + 1 }))
      .filter(({ job }) => !mineOnly || job.data.targetId === requester)
      .map(({ job, n }) => listLine(job, n))
    if (lines.length === 0) {
      await res.send(mineOnly ? "You don't have any pending reminders." : 'No pending reminders in this room.')
      return
    }
    await res.send(lines.join('\n'))
  }

  robot.respond(/(?:list reminders|reminders)$/i, async res => { await handleList(res, false) })

  robot.respond(/my reminders$/i, async res => { await handleList(res, true) })

  robot.respond(/(?:cancel|forget|delete|remove) reminder #?(\d+)$/i, async res => {
    const n = Number(required(res.match, 1))
    const job = roomJobs(reminders.list(), res.message.room)[n - 1]
    if (!job) {
      await res.send(`There's no reminder ${n} here. \`${robot.name} list reminders\` shows the numbers.`)
      return
    }
    const userId = res.message.user.id
    const allowed = [job.data.byId, job.data.targetId, process.env.OWNER_USER_ID].includes(userId)
    if (!allowed) {
      await res.send('Only the person who set that reminder, or the person it is for, can cancel it.')
      return
    }
    reminders.remove(job.id)
    await res.send(`Cancelled reminder for ${mentionOf(job.data)}: ${job.data.message}`)
  })

  robot.respond(/remind (\S+) (.+)$/i, async res => {
    const tz = userTz(robot, res.message.user.id)
    const parsed = parseRequest(required(res.match, 2), tz)
    if (!parsed) {
      await res.send(`I couldn't tell when to remind you. Say \`remind me <when> to <message>\`. ${EXAMPLES}`)
      return
    }

    const target = resolveTarget(robot, res, required(res.match, 1))
    const byId = res.message.user.id
    if (byId !== process.env.OWNER_USER_ID) {
      const all = reminders.list()
      if (all.filter(j => j.data.byId === byId).length >= MAX_PER_PERSON) {
        await res.send(`You already have ${MAX_PER_PERSON} reminders set. Cancel some first (\`${robot.name} list reminders\`).`)
        return
      }
      if (roomJobs(all, res.message.room).length >= MAX_PER_ROOM) {
        await res.send(`This channel already has ${MAX_PER_ROOM} reminders. Cancel some first.`)
        return
      }
      const repeat = parsed.when.repeat
      if (target.id !== byId && repeat?.kind === 'interval' && repeat.everyMs < MIN_OTHERS_INTERVAL_MS) {
        await res.send('Repeating reminders for someone else can be at most hourly.')
        return
      }
    }
    const data: Reminder = { targetId: target.id, targetName: target.name, room: res.message.room, message: parsed.message.trim().slice(0, MAX_MESSAGE_LENGTH), byId }
    reminders.add({ at: parsed.when.at, tz, repeat: parsed.when.repeat, data })

    const whom = target.id === res.message.user.id ? 'you' : mentionOf(data)
    await res.send(`Ok, I'll remind ${whom} ${describeWhen(parsed.when, parsed.whenText, tz)}.`)
  })
}
