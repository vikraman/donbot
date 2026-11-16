import type { Robot } from 'hubot'

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

const logKey = (kind: LogKind): string => `log:${kind}`

const read = (robot: Robot, kind: LogKind): LogEntry[] => {
  const stored = robot.brain.get(logKey(kind))
  return Array.isArray(stored) ? stored.filter((e): e is LogEntry => typeof e?.ts === 'number') : []
}

export const logEvent = (robot: Robot, kind: LogKind, entry: Omit<LogEntry, 'ts'> & { ts?: number }) => {
  const now = Date.now()
  const kept = read(robot, kind).filter(e => now - e.ts < LOG_RETENTION_MS)
  kept.push({ ...entry, ts: entry.ts ?? now })
  robot.brain.set(logKey(kind), kept.slice(-MAX_ENTRIES))
}

// optional room filter; entries without a room match every room
export const eventsSince = <T extends LogEntry = LogEntry>(robot: Robot, kind: LogKind, since: number, room?: string): T[] =>
  read(robot, kind).filter(e => e.ts >= since && (!room || !e.room || e.room === room)) as T[]
