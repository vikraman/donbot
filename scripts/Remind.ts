// Description:
//   Set a reminder for yourself or someone else. Persists in the brain, survives restarts.
//
// Commands:
//   hubot remind me in <N> <unit> to <message> - Reminds you in N minutes/hours to do something.
//   hubot remind <user> in <N> <unit> to <message> - Reminds <user> in N minutes/hours to do something.
//   hubot remind me to <message> in <N> <unit> - Same as above, time clause last.
//   hubot remind <user> to <message> in <N> <unit> - Same as above, time clause last.
//   hubot set a reminder for <N> <unit> to <message> - Same as "remind me in".
//   hubot list reminders - Shows pending reminders in the current room.
//   hubot my reminders - Shows your pending reminders in the current room.
//

import type { Robot, Response } from 'hubot'

import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { randomId } from './lib/random.ts'

const UNIT_MS: Record<string, number> = {
  s: 1000,
  sec: 1000,
  secs: 1000,
  second: 1000,
  seconds: 1000,
  m: 60 * 1000,
  min: 60 * 1000,
  mins: 60 * 1000,
  minute: 60 * 1000,
  minutes: 60 * 1000,
  h: 60 * 60 * 1000,
  hr: 60 * 60 * 1000,
  hrs: 60 * 60 * 1000,
  hour: 60 * 60 * 1000,
  hours: 60 * 60 * 1000
}

const REMINDERS_KEY = 'reminders'

interface Reminder {
  id: string
  targetId?: string
  targetName: string
  room: string
  message: string
  dueAt: number
}

const mentionForReminder = (reminder: Reminder): string =>
  mentionFor({ id: reminder.targetId, name: reminder.targetName })

const scheduleReminder = (robot: Robot, reminder: Reminder) => {
  const delay = reminder.dueAt - Date.now()
  const timer = setTimeout(async () => {
    await robot.messageRoom(reminder.room, `${mentionForReminder(reminder)} reminder: ${reminder.message}`)
    const reminders = robot.brain.get<Reminder[]>(REMINDERS_KEY) || []
    robot.brain.set(REMINDERS_KEY, reminders.filter(r => r.id !== reminder.id))
  }, Math.max(delay, 0))
  timer.unref()
}

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

const formatRemaining = (ms: number): string => {
  const totalSeconds = Math.max(Math.round(ms / 1000), 0)
  const h = Math.floor(totalSeconds / 3600)
  const m = Math.floor((totalSeconds % 3600) / 60)
  const s = totalSeconds % 60
  const parts = []
  if (h > 0) parts.push(`${h}h`)
  if (m > 0) parts.push(`${m}m`)
  if (h === 0 && m === 0) parts.push(`${s}s`)
  return parts.join(' ')
}

const handleList = async (robot: Robot, res: Response, { mineOnly }: { mineOnly: boolean }) => {
  const reminders = robot.brain.get<Reminder[]>(REMINDERS_KEY) || []
  const room = res.message.room
  const requester = res.message.user.id

  const pending = reminders
    .filter(r => r.room === room)
    .filter(r => !mineOnly || r.targetId === requester)
    .sort((a, b) => a.dueAt - b.dueAt)

  if (pending.length === 0) {
    await res.send(mineOnly ? "You don't have any pending reminders." : 'No pending reminders in this room.')
    return
  }

  const lines = pending.map(r => `in ${formatRemaining(r.dueAt - Date.now())} for ${mentionForReminder(r)}: ${r.message}`)
  await res.send(lines.join('\n'))
}

interface RemindArgs {
  who: string
  amount: string
  unit: string
  message: string
}

const handleRemind = async (robot: Robot, res: Response, { who, amount, unit, message }: RemindArgs) => {
  const unitMs = UNIT_MS[unit.toLowerCase()]

  if (!unitMs) {
    await res.send(`I don't understand the unit "${unit}". Try seconds, minutes, or hours.`)
    return
  }

  const target = resolveTarget(robot, res, who)
  const reminder = {
    id: randomId(),
    targetId: target.id,
    targetName: target.name,
    room: res.message.room,
    message: message.trim(),
    dueAt: Date.now() + parseInt(amount, 10) * unitMs
  }

  const reminders = robot.brain.get<Reminder[]>(REMINDERS_KEY) || []
  reminders.push(reminder)
  robot.brain.set(REMINDERS_KEY, reminders)
  scheduleReminder(robot, reminder)

  const whom = target.id === res.message.user.id ? 'you' : mentionForReminder(reminder)
  await res.send(`Ok, I'll remind ${whom} in ${amount} ${unit}.`)
}

export default async (robot: Robot) => {
  robot.brain.on('connected', () => {
    const reminders = robot.brain.get<Reminder[]>(REMINDERS_KEY) || []
    for (const reminder of reminders) {
      scheduleReminder(robot, reminder)
    }
  })

  // list reminders / remind list
  robot.respond(/(?:list reminders|remind(?:ers)? list)$/i, async res => {
    await handleList(robot, res, { mineOnly: false })
  })

  // my reminders
  robot.respond(/my reminders$/i, async res => {
    await handleList(robot, res, { mineOnly: true })
  })

  // remind <who> in <N> <unit> to <message>
  robot.respond(/remind (\S+) in (\d+)\s*([a-z]+)\s+to (.+)$/i, async res => {
    await handleRemind(robot, res, { who: required(res.match, 1), amount: required(res.match, 2), unit: required(res.match, 3), message: required(res.match, 4) })
  })

  // remind <who> to <message> in <N> <unit>
  robot.respond(/remind (\S+) to (.+?) in (\d+)\s*([a-z]+)$/i, async res => {
    await handleRemind(robot, res, { who: required(res.match, 1), amount: required(res.match, 3), unit: required(res.match, 4), message: required(res.match, 2) })
  })

  // set a reminder for <N> <unit> to <message>
  robot.respond(/(?:set (?:a )?)?reminder (?:for|in) (\d+)\s*([a-z]+)(?: to| for)? (.+)$/i, async res => {
    await handleRemind(robot, res, { who: 'me', amount: required(res.match, 1), unit: required(res.match, 2), message: required(res.match, 3) })
  })
}
