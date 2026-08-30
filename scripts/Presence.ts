// Description:
//   Rotates the bot's Discord custom status between live stats and flavor text every 15 minutes.
//

import type { Robot } from 'hubot'

import { pick, shuffle } from './lib/random.ts'

const ROTATE_MS = 15 * 60 * 1000
const REMINDERS_KEY = 'reminders'
const LAST_MESSAGE_KEY = 'seen:last'

const formatUptime = (seconds: number): string => {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  parts.push(`${h}h`, `${m}m`)
  return parts.join(' ')
}

const EMOJI_MOODS = ['🤖', '🦾', '🍺', '👽', '💚', '🔥', '🎉', '🧠', '⚙️', '🚀'] as const

// verbatim donbot lines
const DONBOT_QUOTES = [
  // Bender Gets Made (S2E11)
  "You call this a table? I wouldn't hit a guy over the head with this table.",
  "Huh. I like this guy's lack of style.",
  "Get a load of the ball bearings on this guy. I like you, kid.",
  "I got a good feeling about you. Say, you wanna work for me as a hired goon?",
  'Nice job. You passed the test.',
  'Let that be a warning to you.',
  'We got a big score planned but, uh, we need some muscle.',
  'Their desire to keep living shows me no respect.',
  "Hello, we're the Robot Mafia.",
  "Hey, I like your attitude. Keep it up and I might just get you your own pair of clamps, huh?",
  // Bendless Love (S3E6)
  'How many times is that? Two or three?',
  'Remember, only kill the one with the beard.'
] as const

// fallback when every nullable status is empty
const uptimeStatus = (): string => `Up ${formatUptime(process.uptime())}`

const buildStatuses = (robot: Robot): (() => string | null)[] => [
  uptimeStatus,
  () => {
    const reminders = robot.brain.get<unknown[]>(REMINDERS_KEY) || []
    return reminders.length === 1 ? '1 reminder pending' : `${reminders.length} reminders pending`
  },
  () => {
    const users = Object.values(robot.brain.data.users || {})
    const count = users.length
    return count === 1 ? 'Watching over 1 person' : `Watching over ${count} people`
  },
  () => pick(DONBOT_QUOTES),
  () => {
    const client = robot.adapter && robot.adapter.client
    const count = client && client.guilds && client.guilds.cache ? client.guilds.cache.size : null
    return count === null ? null : count === 1 ? 'In 1 server' : `In ${count} servers`
  },
  () => {
    const count = robot.listeners ? robot.listeners.length : 0
    return count === 1 ? 'Knows 1 trick' : `Knows ${count} tricks`
  },
  () => {
    const mem = process.memoryUsage()
    const heapUsed = (mem.heapUsed / 1024 / 1024).toFixed(1)
    return `Using ${heapUsed}MB`
  },
  () => {
    try {
      const probeKey = 'presence:probe'
      robot.brain.set(probeKey, Date.now())
      const connected = Boolean(robot.brain.get(probeKey))
      const data = robot.brain.data || {}
      const sizeKb = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1)
      return connected ? `Brain: ${sizeKb} KB` : 'Brain: unreachable'
    } catch {
      return 'Brain: unreachable'
    }
  },
  () => {
    const last = robot.brain.get<number>(LAST_MESSAGE_KEY)
    if (!last) return null
    const minutes = Math.floor((Date.now() - last) / 60000)
    if (minutes < 1) return 'Just heard from someone'
    return minutes === 1 ? 'Quiet for 1m' : `Quiet for ${minutes}m`
  },
  () => `Today: ${new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
  () => pick(EMOJI_MOODS)
]

const updatePresence = (robot: Robot) => {
  const client = robot.adapter && robot.adapter.client
  if (!client || !client.isReady || !client.isReady() || !client.user?.setActivity) return

  // try each once instead of spinning
  let text: string | null = null
  for (const status of shuffle(buildStatuses(robot))) {
    text = status()
    if (text !== null) break
  }

  client.user.setActivity(text ?? uptimeStatus(), { type: 4 }) // 4 = Custom
}

export default async (robot: Robot) => {
  robot.brain.on('connected', () => {
    updatePresence(robot)
    const timer = setInterval(() => updatePresence(robot), ROTATE_MS)
    timer.unref()
  })
}
