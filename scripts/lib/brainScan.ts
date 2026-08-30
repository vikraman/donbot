import type { Robot } from 'hubot'

export const isScore = (value: unknown): value is number => typeof value === 'number'

// brain may hold a stale non-number; arithmetic on it would corrupt the score
export const scoreAt = (robot: Robot, key: string): number => {
  const stored = robot.brain.get(key)
  return isScore(stored) ? stored : 0
}

// prefixed _private keys -> [suffix, value]; isValid drops stale shapes
export const entriesWithPrefix = <T>(
  robot: Robot,
  prefix: string,
  isValid?: (value: unknown) => value is T
): [string, T][] => {
  const data = robot.brain.data._private || {}
  const entries: [string, T][] = []
  for (const key of Object.keys(data)) {
    if (!key.startsWith(prefix)) continue
    const value = data[key]
    if (value === undefined) continue
    if (isValid && !isValid(value)) continue
    entries.push([key.slice(prefix.length), value as T])
  }
  return entries
}
