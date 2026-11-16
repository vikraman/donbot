import type { Robot } from 'hubot'

import { mentionFor } from './mention.ts'
import { DAY_MS, dayKey, weekKey } from './time.ts'
import { userTz } from './timezone.ts'

// what a streak counts
export type StreakKind = 'standup' | 'focus' | 'win'

export interface Streak {
  current: number
  best: number
  // period key in the user's tz: yyyy-mm-dd, or the week's monday
  lastDay: string
}

export const MILESTONES = [3, 7, 14, 30, 50, 100, 200, 365] as const

const LABELS: Record<StreakKind, string> = { standup: 'standup', focus: 'focus', win: 'wins' }

// standups are weekly check-ins
const PERIOD: Record<StreakKind, 'day' | 'week'> = { standup: 'week', focus: 'day', win: 'day' }

const periodKey = (kind: StreakKind, ms: number, tz: string): string => PERIOD[kind] === 'week' ? weekKey(ms, tz) : dayKey(ms, tz)

const periodMs = (kind: StreakKind): number => PERIOD[kind] === 'week' ? 7 * DAY_MS : DAY_MS

const streakKey = (kind: StreakKind, userId: string): string => `streak:${kind}:${userId}`

const isStreak = (value: unknown): value is Streak =>
  typeof value === 'object' && value !== null && typeof (value as Streak).current === 'number' && typeof (value as Streak).lastDay === 'string'

export const getStreak = (robot: Robot, kind: StreakKind, userId: string, now = Date.now()): Streak | undefined => {
  const stored = robot.brain.get(streakKey(kind, userId))
  if (!isStreak(stored)) return undefined
  const tz = userTz(robot, userId)
  // broken once a full period passes without activity
  const alive = stored.lastDay === periodKey(kind, now, tz) || stored.lastDay === periodKey(kind, now - periodMs(kind), tz)
  return alive ? stored : { ...stored, current: 0 }
}

// counts this period once; returns a milestone line when one is reached
export const recordStreak = (robot: Robot, kind: StreakKind, userId: string, now = Date.now()): string | undefined => {
  const tz = userTz(robot, userId)
  const current = periodKey(kind, now, tz)
  const prev = getStreak(robot, kind, userId, now)
  if (prev && prev.lastDay === current) return undefined
  const count = prev && prev.current > 0 ? prev.current + 1 : 1
  const next: Streak = { current: count, best: Math.max(count, prev?.best ?? 0), lastDay: current }
  robot.brain.set(streakKey(kind, userId), next)
  if (!(MILESTONES as readonly number[]).includes(count)) return undefined
  return `🔥 ${mentionFor({ id: userId })} is on a ${count}-${PERIOD[kind]} ${LABELS[kind]} streak!`
}

export const streakLabel = (kind: StreakKind): string => LABELS[kind]
