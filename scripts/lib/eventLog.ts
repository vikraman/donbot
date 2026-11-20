import type { Robot } from 'hubot'

import { spaceKey, spaceOf, type SpaceId } from './spaces.ts'
import { DAY_MS } from './time.ts'

// shared timeline for recaps, kept short
export const LOG_RETENTION_MS = 60 * DAY_MS
const MAX_ENTRIES = 2000

export type LogKind = 'kudos' | 'win' | 'focus' | 'github' | 'standup'

export interface LogEntry {
  ts: number
  room?: string
  userId?: string
  [field: string]: unknown
}

// one log per space
const logKey = (kind: LogKind, space: SpaceId): string => spaceKey(space, `log:${kind}`)

const read = (robot: Robot, kind: LogKind, space: SpaceId): LogEntry[] => {
  const stored = robot.brain.get(logKey(kind, space))
  return Array.isArray(stored) ? stored.filter((e): e is LogEntry => typeof e?.ts === 'number') : []
}

const spaceFor = (robot: Robot, where: { room?: string, space?: SpaceId }): SpaceId =>
  where.space ?? (where.room ? spaceOf(robot, where.room) : '')

export const logEvent = (robot: Robot, kind: LogKind, entry: Omit<LogEntry, 'ts'> & { ts?: number, room?: string, space?: SpaceId }) => {
  const now = Date.now()
  const space = spaceFor(robot, entry)
  const { space: _, ...rest } = entry
  const kept = read(robot, kind, space).filter(e => now - e.ts < LOG_RETENTION_MS)
  kept.push({ ...rest, ts: entry.ts ?? now })
  robot.brain.set(logKey(kind, space), kept.slice(-MAX_ENTRIES))
}

export interface Where {
  room?: string
  space?: SpaceId
}

// room implies space; roomless entries always match
export const eventsSince = <T extends LogEntry = LogEntry>(robot: Robot, kind: LogKind, since: number, where?: string | Where): T[] => {
  const w = typeof where === 'string' ? { room: where } : where ?? {}
  return read(robot, kind, spaceFor(robot, w)).filter(e => e.ts >= since && (!w.room || !e.room || e.room === w.room)) as T[]
}
