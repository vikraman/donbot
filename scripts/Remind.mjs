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

const UNIT_MS = {
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

import { mentionFor } from './lib/mention.mjs'

const REMINDERS_KEY = 'reminders'

const mentionForReminder = reminder => mentionFor({ id: reminder.targetId, name: reminder.targetName })

const scheduleReminder = (robot, reminder) => {
  const delay = reminder.dueAt - Date.now()
  const timer = setTimeout(async () => {
    await robot.messageRoom(reminder.room, `${mentionForReminder(reminder)} reminder: ${reminder.message}`)
    const reminders = robot.brain.get(REMINDERS_KEY) || []
    robot.brain.set(REMINDERS_KEY, reminders.filter(r => r.id !== reminder.id))
  }, Math.max(delay, 0))
  timer.unref()
}

// "me" is the sender; mention/name is looked up in the brain, else falls back to raw text
const resolveTarget = (robot, res, who) => {
  const trimmed = who.trim()
  if (!trimmed || trimmed.toLowerCase() === 'me') {
    return { id: res.message.user.id, name: res.message.user.name }
  }

  const mentionMatch = trimmed.match(/^<@!?(\d+)>$/)
  if (mentionMatch) {
    const user = robot.brain.userForId(mentionMatch[1])
    return { id: mentionMatch[1], name: (user && user.name) || trimmed }
  }

  const name = trimmed.replace(/^@/, '')
  const users = robot.brain.usersForFuzzyName(name)
  return users.length === 1 ? { id: users[0].id, name: users[0].name } : { id: null, name }
}

const formatRemaining = ms => {
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

const handleList = async (robot, res, { mineOnly }) => {
  const reminders = robot.brain.get(REMINDERS_KEY) || []
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

const handleRemind = async (robot, res, { who, amount, unit, message }) => {
  const unitMs = UNIT_MS[unit.toLowerCase()]

  if (!unitMs) {
    await res.send(`I don't understand the unit "${unit}". Try seconds, minutes, or hours.`)
    return
  }

  const target = resolveTarget(robot, res, who)
  const reminder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    targetId: target.id,
    targetName: target.name,
    room: res.message.room,
    message: message.trim(),
    dueAt: Date.now() + parseInt(amount, 10) * unitMs
  }

  const reminders = robot.brain.get(REMINDERS_KEY) || []
  reminders.push(reminder)
  robot.brain.set(REMINDERS_KEY, reminders)
  scheduleReminder(robot, reminder)

  const whom = target.id === res.message.user.id ? 'you' : mentionForReminder(reminder)
  await res.send(`Ok, I'll remind ${whom} in ${amount} ${unit}.`)
}

export default async (robot) => {
  robot.brain.on('connected', () => {
    const reminders = robot.brain.get(REMINDERS_KEY) || []
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
    await handleRemind(robot, res, { who: res.match[1], amount: res.match[2], unit: res.match[3], message: res.match[4] })
  })

  // remind <who> to <message> in <N> <unit>
  robot.respond(/remind (\S+) to (.+?) in (\d+)\s*([a-z]+)$/i, async res => {
    await handleRemind(robot, res, { who: res.match[1], amount: res.match[3], unit: res.match[4], message: res.match[2] })
  })

  // set a reminder for <N> <unit> to <message>
  robot.respond(/(?:set (?:a )?)?reminder (?:for|in) (\d+)\s*([a-z]+)(?: to| for)? (.+)$/i, async res => {
    await handleRemind(robot, res, { who: 'me', amount: res.match[1], unit: res.match[2], message: res.match[3] })
  })
}
