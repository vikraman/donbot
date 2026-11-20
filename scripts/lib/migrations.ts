import type { Robot } from 'hubot'

// one-time migrations, in id order
// applied ids kept in the brain

export interface Migration {
  id: string
  // false: retry next connect
  run: (robot: Robot) => Promise<boolean | void> | boolean | void
}

export const MIGRATIONS_KEY = 'migrations'

const registry = new Map<string, Migration>()

export const defineMigration = (migration: Migration) => { registry.set(migration.id, migration) }

export const appliedMigrations = (robot: Robot): Record<string, number> => {
  const stored = robot.brain.get(MIGRATIONS_KEY)
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, number> : {}
}

interface ClientLike {
  isReady?: () => boolean
  guilds?: { cache?: Map<string, unknown> }
  channels?: { cache?: Map<string, unknown>, fetch?: (id: string) => Promise<unknown> }
}

export const discordOf = (robot: Robot): ClientLike | undefined => robot.adapter?.client as ClientLike | undefined

export const guildIds = (robot: Robot): string[] => [...discordOf(robot)?.guilds?.cache?.keys() ?? []]

// threads and dms aren't cached
export const fetchRoom = async (robot: Robot, room: string) => {
  const channels = discordOf(robot)?.channels
  if (channels?.cache?.has(room)) return
  try { await channels?.fetch?.(room) } catch {}
}

const installed = new WeakSet<Robot>()

export const runMigrations = async (robot: Robot): Promise<string[]> => {
  const client = discordOf(robot)
  // needs discord
  if (!client?.isReady?.()) return []
  const ran: string[] = []
  for (const id of [...registry.keys()].sort()) {
    if (appliedMigrations(robot)[id]) continue
    try {
      if (await registry.get(id)!.run(robot) === false) break
    } catch (err) {
      robot.logger.error(`migration ${id}: ${err instanceof Error ? err.message : String(err)}`)
      // later ones may depend on it
      break
    }
    robot.brain.set(MIGRATIONS_KEY, { ...appliedMigrations(robot), [id]: Date.now() })
    robot.logger.info(`migration ${id}: done`)
    ran.push(id)
  }
  return ran
}

export const installMigrations = (robot: Robot) => {
  if (installed.has(robot)) return
  installed.add(robot)
  let running: Promise<unknown> | undefined
  robot.brain.on('connected', () => {
    running ??= runMigrations(robot).finally(() => { running = undefined })
  })
}
