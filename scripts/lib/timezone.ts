import type { Robot } from 'hubot'

import { canonicalTz, DEFAULT_TZ } from './time.ts'

const tzKey = (userId: string): string => `tz:user:${userId}`

// fallback for people who never set one
export const defaultTz = (): string => canonicalTz(process.env.DEFAULT_TIMEZONE || '') ?? DEFAULT_TZ

export const userTz = (robot: Robot, userId: string | undefined): string => {
  const stored = userId ? robot.brain.get(tzKey(userId)) : undefined
  return typeof stored === 'string' ? canonicalTz(stored) ?? defaultTz() : defaultTz()
}

// " (tz)" unless it's the default everyone shares
export const tzNote = (tz: string): string => tz === defaultTz() ? '' : ` (${tz})`

export const setUserTz = (robot: Robot, userId: string, tz: string) => robot.brain.set(tzKey(userId), tz)
