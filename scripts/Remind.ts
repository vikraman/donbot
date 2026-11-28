// Description:
//   Set one-off or recurring reminders for yourself or someone else. Times use your timezone
//   (see `hubot my timezone is`). Persists in the brain, survives restarts.
//
// Commands:
//   hubot remind me <when> <message> - Reminds you, e.g. in 10 minutes, tonight, at 3pm, tomorrow morning, next friday at 10:30, on dec 1.
//   hubot remind me <message> <when> - Same, time last, e.g. remind me to call mom in half an hour.
//   hubot remind <user> <when> <message> - Reminds <user> instead.
//   hubot remind me every <when> <message> - Recurring, e.g. every weekday at 9am, every morning, every 2 hours, on mondays, every month on the 1st.
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
import { DAY_MS, describeRepeat, formatWhen, HOUR_MS } from './lib/time.ts'
import type { When } from './lib/time.ts'
import { findWhen } from './lib/when.ts'
import { tzNote, userTz } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { peopleFor } from './lib/spaces.ts'
import { isOwner } from './lib/owner.ts'

defineFeature({ id: 'remind', label: 'Reminders', level: 'professional', help: ['hubot remind', 'hubot list reminders', 'hubot my reminders', 'hubot cancel reminder'] })

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

const EXAMPLES = 'Try `in 10 minutes`, `tonight`, `at 3pm`, `tomorrow morning`, `next friday at 10:30`, `on dec 1`, `every weekday at 9am` or `every 2 hours`.'

const NO_MESSAGE = '(no message)'

const mentionOf = (r: Reminder): string => mentionFor({ id: r.targetId, name: r.targetName })

interface Target {
  id?: string
  name: string
}

// me, or someone known here
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
  const users = peopleFor(robot, res, name)
  const sole = users.length === 1 ? users[0] : undefined
  return sole ? { id: sole.id, name: sole.name } : { name }
}

interface Parsed {
  when: When
  whenText: string
  message: string
}

// time first or last, any connector: "tonight that I owe bob £5", "to call mom at 3pm", "at 11pm I owe bob"
export const parseRequest = (body: string, tz: string, now = Date.now()): Parsed | undefined => {
  const found = findWhen(body, tz, now)
  if (!found) return undefined
  const message = found.rest.replace(/^(?:[:\-–—]\s*)?(?:(?:to|that|of)\s+)?/i, '').trim()
  return { when: found.when, whenText: found.phrase, message }
}

const describeWhen = (when: When, whenText: string, tz: string): string => {
  if (when.repeat?.kind === 'interval') {
    // "every other day at 8am" keeps its clock
    const daily = when.repeat.everyMs % DAY_MS === 0 && !/^\s*every \S+ \S+\s*$/i.test(whenText)
    return daily ? `${describeRepeat(when.repeat)}, starting ${formatWhen(when.at, tz)}${tzNote(tz)}` : describeRepeat(when.repeat)
  }
  if (when.repeat) return `${describeRepeat(when.repeat)}${tzNote(tz)}`
  if (/^\s*in \D/i.test(whenText) || /^\s*in \d+\s*[a-z]/i.test(whenText)) return whenText.trim().toLowerCase()
  return `${formatWhen(when.at, tz)}${tzNote(tz)}`
}

const roomJobs = (jobs: Job<Reminder>[], room: string): Job<Reminder>[] =>
  jobs.filter(j => j.data.room === room).sort((a, b) => a.at - b.at)

const listLine = (job: Job<Reminder>, n: number): string => {
  const due = formatWhen(job.at, job.tz)
  const repeat = job.repeat ? `, ${describeRepeat(job.repeat)}` : ''
  return `${n}. ${due}${repeat} for ${mentionOf(job.data)}: ${job.data.message || NO_MESSAGE}`
}

export default async (robot: Robot) => {
  const reminders = scheduler<Reminder>(robot, 'remind', async job => {
    const text = job.data.message ? `reminder: ${job.data.message}` : 'here is the reminder you asked for.'
    await postToRoom(robot, job.data.room, `${mentionOf(job.data)} ${text}`, 'remind')
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

  robot.respond(/(?:list reminders|reminders)$/i, { id: 'remind.list' }, async res => { await handleList(res, false) })

  robot.respond(/my reminders$/i, { id: 'remind.mine' }, async res => { await handleList(res, true) })

  robot.respond(/(?:cancel|forget|delete|remove) reminder #?(\d+)$/i, { id: 'remind.cancel' }, async res => {
    const n = Number(required(res.match, 1))
    const job = roomJobs(reminders.list(), res.message.room)[n - 1]
    if (!job) {
      await res.send(`There's no reminder ${n} here. \`${robot.name} list reminders\` shows the numbers.`)
      return
    }
    const userId = res.message.user.id
    const allowed = [job.data.byId, job.data.targetId].includes(userId) || isOwner(res)
    if (!allowed) {
      await res.send('Only the person who set that reminder, or the person it is for, can cancel it.')
      return
    }
    reminders.remove(job.id)
    await res.send(`Cancelled reminder for ${mentionOf(job.data)}: ${job.data.message}`)
  })

  robot.respond(/(?:(?:can|could|would) you |please |pls )*remind (\S+) (.+?)[.!]?$/i, { id: 'remind.add' }, async res => {
    const tz = userTz(robot, res.message.user.id)
    const parsed = parseRequest(required(res.match, 2), tz)
    if (!parsed) {
      await res.send(`I couldn't find a time in that. Put it at the start or the end, like \`remind me tomorrow at 9 to call bob\`. ${EXAMPLES}`)
      return
    }

    const target = resolveTarget(robot, res, required(res.match, 1))
    const byId = res.message.user.id
    if (!isOwner(res)) {
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
    const what = data.message ? `: ${data.message}` : '.'
    await res.send(`Ok, I'll remind ${whom} ${describeWhen(parsed.when, parsed.whenText, tz)}${what}`)
  })
}
