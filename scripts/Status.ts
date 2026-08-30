// Description:
//   Reports bot status. Default is a quick summary; add "verbose"/"detailed" for full details.
//
// Commands:
//   hubot status - Shows a quick status summary.
//   hubot status verbose - Shows detailed bot status.
//   hubot uptime - Shows how long the bot has been running.
//

import type { Robot } from 'hubot'

import hubotPackage from 'hubot/package.json' with { type: 'json' }

const formatUptime = (seconds: number): string => {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  const parts = []
  if (d > 0) parts.push(`${d}d`)
  parts.push(`${h}h`, `${m}m`, `${s}s`)
  return parts.join(' ')
}

const redisHost = () => {
  const url = process.env.REDIS_URL || process.env.REDISTOGO_URL || process.env.REDISCLOUD_URL || process.env.BOXEN_REDIS_URL
  if (!url) return 'localhost:6379 (default)'
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}:${parsed.port || '6379'}`
  } catch {
    return 'unknown'
  }
}

interface BrainDetails {
  status: string
  host: string
  userCount: number
  keyCount: number
  sizeKb: string
}

const brainDetails = (robot: Robot): BrainDetails => {
  try {
    const probeKey = 'status:probe'
    robot.brain.set(probeKey, Date.now())
    const connected = Boolean(robot.brain.get(probeKey))

    const data = robot.brain.data || {}
    const userCount = data.users ? Object.keys(data.users).length : 0
    const keyCount = data._private ? Object.keys(data._private).length : 0
    const sizeKb = (Buffer.byteLength(JSON.stringify(data)) / 1024).toFixed(1)

    return {
      status: connected ? 'connected' : 'unreachable',
      host: redisHost(),
      userCount,
      keyCount,
      sizeKb
    }
  } catch {
    return { status: 'unreachable', host: redisHost(), userCount: 0, keyCount: 0, sizeKb: '0.0' }
  }
}

const WS_STATUS = ['Ready', 'Connecting', 'Reconnecting', 'Idle', 'Nearly', 'Disconnected', 'WaitingForGuilds', 'Identifying', 'Resuming']

const discordInfo = (robot: Robot): string | null => {
  const client = robot.adapter && robot.adapter.client
  if (!client || !client.isReady || !client.isReady()) return null

  const tag = client.user ? (client.user.tag || client.user.username) : 'unknown'
  const guilds = client.guilds && client.guilds.cache ? client.guilds.cache.size : 'unknown'
  const channels = client.channels && client.channels.cache ? client.channels.cache.size : 'unknown'
  const users = client.users && client.users.cache ? client.users.cache.size : 'unknown'
  const ping = client.ws && typeof client.ws.ping === 'number' ? `${client.ws.ping}ms` : 'unknown'
  const wsStatus = client.ws && typeof client.ws.status === 'number' ? WS_STATUS[client.ws.status] || `code ${client.ws.status}` : 'unknown'
  const connUptime = typeof client.uptime === 'number' ? formatUptime(client.uptime / 1000) : 'unknown'

  return [
    `Discord: logged in as ${tag}`,
    `Servers: ${guilds}, channels: ${channels}, cached users: ${users}`,
    `Gateway: ${wsStatus}, ping ${ping}, connected ${connUptime}`
  ].join('\n')
}

export default async (robot: Robot) => {
  robot.respond(/uptime$/i, async res => {
    await res.send(`Uptime: ${formatUptime(process.uptime())}`)
  })

  robot.respond(/(?:status|health(?:check)?|how are you(?: doing| feeling)?)(\s+verbose|\s+detailed)?$/i, async res => {
    const verbose = Boolean(res.match[1])
    const uptime = formatUptime(process.uptime())
    const brain = brainDetails(robot)

    if (!verbose) {
      await res.send(`Uptime: ${uptime} | Brain: ${brain.status} | All good.`)
      return
    }

    const mem = process.memoryUsage()
    const rss = (mem.rss / 1024 / 1024).toFixed(1)
    const heapUsed = (mem.heapUsed / 1024 / 1024).toFixed(1)
    const heapTotal = (mem.heapTotal / 1024 / 1024).toFixed(1)
    const scriptCount = robot.listeners ? robot.listeners.length : 'unknown'

    const lines = [
      `Uptime: ${uptime}`,
      `Memory: ${rss} MB (heap ${heapUsed}/${heapTotal} MB)`,
      `Brain: ${brain.status} (${brain.host}) — ${brain.userCount} users, ${brain.keyCount} keys, ${brain.sizeKb} KB`,
      `Listeners: ${scriptCount}`,
      `Node: ${process.version} (${process.platform}/${process.arch})`,
      `Hubot: ${hubotPackage.version || 'unknown'}`
    ]

    const discord = discordInfo(robot)
    if (discord) lines.push(discord)

    await res.send(lines.join('\n'))
  })
}
