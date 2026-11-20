// Description:
//   Deadlines for a channel, with a reminder the day before and a note when each is due.
//
// Commands:
//   hubot deadline <title> due <when> - Adds a deadline, e.g. "friday at 5pm", "dec 12", "2026-12-12 17:00" (Manage Channels).
//   hubot deadlines - Lists upcoming deadlines here.
//   hubot remove deadline <n> - Removes deadline <n> from the list (Manage Channels).
//
// Notes:
//   A date without a time means the end of that day, in the setter's timezone.
//

import type { Robot, Response } from 'hubot'

import { formatDuration } from './lib/duration.ts'
import { defineFeature } from './lib/features.ts'
import { required } from './lib/match.ts'
import { canManage, MANAGE_ONLY } from './lib/permissions.ts'
import { postToRoom } from './lib/rooms.ts'
import { scheduler } from './lib/schedule.ts'
import type { Job } from './lib/schedule.ts'
import { DAY_MS, MAX_AHEAD_MS, formatWhen, fromZoned, parseClock, parseWhen, zonedParts } from './lib/time.ts'
import { tzNote, userTz } from './lib/timezone.ts'

defineFeature({ id: 'deadlines', label: 'Deadlines', level: 'professional', help: ['hubot deadline', 'hubot remove deadline'] })

interface Deadline {
  room: string
  title: string
  due: number
  by: string
  stage: 'remind' | 'due'
}

export const MAX_PER_ROOM = 25
const MAX_TITLE = 100
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

const clockOf = (text: string | undefined): { hour: number, minute: number } | undefined =>
  text ? parseClock(text.trim()) : { hour: 23, minute: 59 }

// iso or month-name dates, end of day unless a time is given; else anything parseWhen takes
export const parseDue = (text: string, tz: string, now = Date.now()): number | undefined => {
  const t = text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/^on /, '')
  let year: number | undefined
  let month: number | undefined
  let day: number | undefined
  let clockText: string | undefined
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ t](?:at )?(.+))?$/)
  if (m) {
    year = Number(m[1]); month = Number(m[2]); day = Number(m[3]); clockText = m[4]
  } else if ((m = t.match(/^([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?(?:,? (\d{4}))?(?: at (.+))?$/)) && MONTHS.includes(m[1]!)) {
    month = MONTHS.indexOf(m[1]!) + 1; day = Number(m[2]); year = m[3] ? Number(m[3]) : undefined; clockText = m[4]
  } else if ((m = t.match(/^(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3})[a-z]*(?:,? (\d{4}))?(?: at (.+))?$/)) && MONTHS.includes(m[2]!)) {
    day = Number(m[1]); month = MONTHS.indexOf(m[2]!) + 1; year = m[3] ? Number(m[3]) : undefined; clockText = m[4]
  }
  if (month !== undefined && day !== undefined) {
    const clock = clockOf(clockText)
    if (!clock || month < 1 || month > 12 || day < 1 || day > 31) return undefined
    const thisYear = zonedParts(now, tz).year
    let at = fromZoned(year ?? thisYear, month, day, clock.hour, clock.minute, tz)
    // a month and day already past means next year
    if (year === undefined && at <= now) at = fromZoned(thisYear + 1, month, day, clock.hour, clock.minute, tz)
    return at > now && at - now <= MAX_AHEAD_MS ? at : undefined
  }
  const when = parseWhen(t, tz, now)
  return when && !when.repeat ? when.at : undefined
}

const roomDeadlines = (jobs: Job<Deadline>[], room: string): Job<Deadline>[] =>
  jobs.filter(j => j.data.room === room).sort((a, b) => a.data.due - b.data.due)

export default async (robot: Robot) => {
  const deadlines = scheduler<Deadline>(robot, 'deadline', async job => {
    const d = job.data
    if (d.stage === 'remind' && Date.now() < d.due) {
      await postToRoom(robot, d.room, `⏰ Reminder: **${d.title}** is due ${formatWhen(d.due, job.tz)}${tzNote(job.tz)}.`, 'deadlines')
      deadlines.add({ ...job, at: d.due, data: { ...d, stage: 'due' } })
      return
    }
    await postToRoom(robot, d.room, `📌 **${d.title}** is due now.`, 'deadlines')
  })

  const staffOnly = async (res: Response): Promise<boolean> => {
    if (canManage(res, 'channel')) return true
    await res.send(MANAGE_ONLY.channel)
    return false
  }

  robot.respond(/deadline (.+?) due (.+)$/i, { id: 'deadlines.add' }, async res => {
    if (!await staffOnly(res)) return
    const title = required(res.match, 1).trim().slice(0, MAX_TITLE)
    const tz = userTz(robot, res.message.user.id)
    const due = parseDue(required(res.match, 2), tz)
    if (!due) {
      await res.send('I couldn\'t tell when that\'s due. Try "friday at 5pm", "dec 12" or "2026-12-12 17:00".')
      return
    }
    const room = res.message.room
    if (roomDeadlines(deadlines.list(), room).length >= MAX_PER_ROOM) {
      await res.send(`This channel already has ${MAX_PER_ROOM} deadlines. Remove some first.`)
      return
    }
    const remindAt = due - DAY_MS
    const stage = remindAt > Date.now() ? 'remind' : 'due'
    deadlines.add({ at: stage === 'remind' ? remindAt : due, tz, data: { room, title, due, by: res.message.user.id, stage } })
    await res.send(`📅 **${title}** is due ${formatWhen(due, tz)}${tzNote(tz)}.${stage === 'remind' ? ' I\'ll post a reminder the day before.' : ''}`)
  })

  robot.respond(/deadlines$/i, { id: 'deadlines.list' }, async res => {
    const now = Date.now()
    const lines = roomDeadlines(deadlines.list(), res.message.room)
      .map((job, i) => `${i + 1}. **${job.data.title}**: ${formatWhen(job.data.due, job.tz)}${tzNote(job.tz)} (in ${formatDuration(job.data.due - now)})`)
    await res.send(lines.length ? lines.join('\n') : `No deadlines here. \`${robot.name} deadline <title> due <when>\` adds one.`)
  })

  robot.respond(/(?:remove|cancel|delete) deadline #?(\d+)$/i, { id: 'deadlines.remove' }, async res => {
    if (!await staffOnly(res)) return
    const n = Number(required(res.match, 1))
    const job = roomDeadlines(deadlines.list(), res.message.room)[n - 1]
    if (!job) {
      await res.send(`There's no deadline ${n} here. \`${robot.name} deadlines\` shows the numbers.`)
      return
    }
    deadlines.remove(job.id)
    await res.send(`Removed **${job.data.title}**.`)
  })
}
