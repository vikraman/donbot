// Description:
//   Set a reminder for later. Reminders persist in the brain and are
//   rescheduled on startup, so they survive restarts and redeploys.
//
// Commands:
//   hubot remind me in <N> <unit> to <message> - Reminds you in N minutes/hours to do something.
//   hubot set a reminder for <N> <unit> to <message> - Same as above.
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

const REMINDERS_KEY = 'reminders'

const scheduleReminder = (robot, reminder) => {
  const delay = reminder.dueAt - Date.now()
  const timer = setTimeout(async () => {
    await robot.messageRoom(reminder.room, `@${reminder.userName} reminder: ${reminder.message}`)
    const reminders = robot.brain.get(REMINDERS_KEY) || []
    robot.brain.set(REMINDERS_KEY, reminders.filter(r => r.id !== reminder.id))
  }, Math.max(delay, 0))
  timer.unref()
}

const handleRemind = async (robot, res) => {
  const amount = parseInt(res.match[1], 10)
  const unit = res.match[2].toLowerCase()
  const message = res.match[3].trim()
  const unitMs = UNIT_MS[unit]

  if (!unitMs) {
    await res.send(`I don't understand the unit "${unit}". Try seconds, minutes, or hours.`)
    return
  }

  const reminder = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    userName: res.message.user.name,
    room: res.message.room,
    message,
    dueAt: Date.now() + amount * unitMs
  }

  const reminders = robot.brain.get(REMINDERS_KEY) || []
  reminders.push(reminder)
  robot.brain.set(REMINDERS_KEY, reminders)
  scheduleReminder(robot, reminder)

  await res.send(`Ok, I'll remind you in ${amount} ${unit}.`)
}

export default async (robot) => {
  robot.brain.on('connected', () => {
    const reminders = robot.brain.get(REMINDERS_KEY) || []
    for (const reminder of reminders) {
      scheduleReminder(robot, reminder)
    }
  })

  robot.respond(/remind me in (\d+)\s*([a-z]+)\s+to (.+)$/i, async res => {
    await handleRemind(robot, res)
  })
  robot.respond(/(?:set (?:a )?)?reminder (?:for|in) (\d+)\s*([a-z]+)(?: to| for)? (.+)$/i, async res => {
    await handleRemind(robot, res)
  })
}
