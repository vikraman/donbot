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
import { DAY_MS, formatWhen } from './lib/time.ts'
import { parseWhen } from './lib/when.ts'
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
const END_OF_DAY = { hour: 23, minute: 59 }

// "dec 12", "2026-12-12 17:00", "friday", "in 3 days"; end of day unless a time is given
export const parseDue = (text: string, tz: string, now = Date.now()): number | undefined => {
  const when = parseWhen(text, tz, now, { defaultClock: END_OF_DAY })
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
