// Description:
//   Moves data from before spaces (one global brain) into per-server spaces, once. See lib/spaces.ts.
//
// Configuration:
//   LEGACY_GUILD_ID - Server that inherits old global data (scores, streaks, names). Optional when donbot is in one server.
//

import type { Robot } from 'hubot'

import { entriesWithPrefix } from './lib/brainScan.ts'
import { defineMigration, fetchRoom, guildIds, installMigrations } from './lib/migrations.ts'
import { spaceKey, spaceOf, type Member, type SpaceId } from './lib/spaces.ts'

// global keys moving into a space
const MOVED_PREFIXES = ['plusplus:', 'kudos:reasons:', 'praise:user:', 'wins:count:', 'streak:']
const MOVED_KEYS = ['praise:count', 'count']
const LOG_KINDS = ['kudos', 'win', 'focus', 'github', 'standup']
const SEEN_PREFIX = 'seen:'
const SEEN_LAST = 'seen:last'

interface LegacySeen {
  name?: string
  time?: number
  where?: Record<string, number>
}

defineMigration({
  id: '002-spaces',
  run: async robot => {
    const data = robot.brain.data._private || {}
    const users = Object.values(robot.brain.data.users || {})
    const moved = Object.keys(data).filter(key => MOVED_KEYS.includes(key) || MOVED_PREFIXES.some(p => key.startsWith(p)))
    const seen = entriesWithPrefix<LegacySeen>(robot, SEEN_PREFIX).filter(([id]) => `${SEEN_PREFIX}${id}` !== SEEN_LAST)
    const logs = LOG_KINDS.filter(kind => Array.isArray(data[`log:${kind}`]))
    const roles = users.filter(u => Array.isArray(u.roles) && u.roles.length > 0)
    if (moved.length + seen.length + logs.length + roles.length + users.length === 0) return

    const guilds = guildIds(robot)
    const legacy = process.env.LEGACY_GUILD_ID || (guilds.length === 1 ? guilds[0] : undefined)
    if (!legacy) {
      robot.logger.error(`spaces: in ${guilds.length} servers; set LEGACY_GUILD_ID to the one that inherits old global data`)
      return false
    }
    const home: SpaceId = `g:${legacy}`
    // unplaceable rooms go home
    const placed = new Map<string, SpaceId>()
    const placeRoom = async (room: unknown): Promise<SpaceId> => {
      if (typeof room !== 'string') return home
      if (!placed.has(room)) {
        await fetchRoom(robot, room)
        const space = spaceOf(robot, room)
        placed.set(room, space.startsWith('g:') || space.startsWith('dm:') ? space : home)
      }
      return placed.get(room)!
    }

    for (const key of moved) {
      robot.brain.set(spaceKey(home, key), data[key])
      robot.brain.remove(key)
    }

    for (const kind of logs) {
      const bySpace = new Map<SpaceId, unknown[]>()
      for (const entry of data[`log:${kind}`] as Array<{ room?: unknown }>) {
        const space = await placeRoom(entry?.room)
        bySpace.set(space, [...bySpace.get(space) ?? [], entry])
      }
      for (const [space, entries] of bySpace) {
        const key = spaceKey(space, `log:${kind}`)
        const existing = robot.brain.get<unknown[]>(key)
        robot.brain.set(key, [...entries, ...Array.isArray(existing) ? existing : []])
      }
      robot.brain.remove(`log:${kind}`)
    }

    // names go home, seen times where seen
    const members = new Map<SpaceId, Record<string, Member>>()
    const member = (space: SpaceId, id: string, name: string, time?: number) => {
      const all = members.get(space) ?? robot.brain.get<Record<string, Member>>(spaceKey(space, 'members')) ?? {}
      const old = all[id]
      all[id] = { ...old, name: old?.name ?? name, ...(time !== undefined && { seen: Math.max(time, old?.seen ?? 0) }) }
      members.set(space, all)
    }
    for (const u of users) if (u.name) member(home, String(u.id), u.name)
    for (const [id, entry] of seen) {
      const name = entry?.name ?? robot.brain.data.users?.[id]?.name ?? id
      const where = entry?.where && Object.keys(entry.where).length > 0 ? entry.where : { [legacy]: entry?.time }
      for (const [guild, time] of Object.entries(where)) {
        if (typeof time === 'number') member(guild ? `g:${guild}` : home, id, name, time)
      }
      robot.brain.remove(`${SEEN_PREFIX}${id}`)
    }
    for (const [space, all] of members) robot.brain.set(spaceKey(space, 'members'), all)

    if (roles.length > 0) {
      const existing = robot.brain.get<Record<string, string[]>>(spaceKey(home, 'roles')) ?? {}
      robot.brain.set(spaceKey(home, 'roles'), { ...existing, ...Object.fromEntries(roles.map(u => [String(u.id), u.roles as string[]])) })
      for (const u of roles) delete u.roles
    }
    robot.logger.info(`spaces: moved ${moved.length} keys, ${logs.length} logs, ${seen.length} seen times and ${users.length} names into ${home}`)
  }
})

export default async (robot: Robot) => {
  installMigrations(robot)
}
