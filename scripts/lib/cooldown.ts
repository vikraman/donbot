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

export interface Burst {
  // true and counted while under the limit in the window
  take: (key: string, now?: number) => boolean
}

// in-memory keyed sliding-window limit
export const burst = (limit: number, ms: number): Burst => {
  // insertion order is last-hit order, so idle keys sit at the front
  const hits = new Map<string, number[]>()

  const prune = (now: number) => {
    for (const [key, times] of hits) {
      if (now - times.at(-1)! < ms) break
      hits.delete(key)
    }
  }

  const take = (key: string, now = Date.now()): boolean => {
    prune(now)
    const recent = (hits.get(key) ?? []).filter(t => now - t < ms)
    if (recent.length >= limit) return false
    recent.push(now)
    hits.delete(key)
    hits.set(key, recent)
    return true
  }

  return { take }
}
