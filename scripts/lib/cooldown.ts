export interface Cooldown {
  ready: (key: string, now?: number) => boolean
  mark: (key: string, now?: number) => void
  // ready, then mark
  take: (key: string, now?: number) => boolean
}

// in-memory keyed cooldown, expired keys pruned on access
export const cooldown = (ms: number): Cooldown => {
  // insertion order is mark order, so expired keys sit at the front
  const markedAt = new Map<string, number>()

  const prune = (now: number) => {
    for (const [key, at] of markedAt) {
      if (now - at < ms) break
      markedAt.delete(key)
    }
  }

  const ready = (key: string, now = Date.now()): boolean => {
    prune(now)
    return !markedAt.has(key)
  }

  const mark = (key: string, now = Date.now()) => {
    markedAt.delete(key)
    markedAt.set(key, now)
  }

  const take = (key: string, now = Date.now()): boolean => {
    if (!ready(key, now)) return false
    mark(key, now)
    return true
  }

  return { ready, mark, take }
}
