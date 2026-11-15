const UNITS: Array<[string, number]> = [['d', 86_400_000], ['h', 3_600_000], ['m', 60_000], ['s', 1000]]

export interface DurationOptions {
  // ceil for countdowns
  round?: (n: number) => number
  units?: number
}

// largest units first, e.g. 1h 30m
export const formatDuration = (ms: number, { round = Math.floor, units = 2 }: DurationOptions = {}): string => {
  const total = Math.max(0, ms)
  const first = UNITS.findIndex(([, size]) => total >= size)
  const shown = UNITS.slice(0, first === -1 ? UNITS.length : Math.min(first + units, UNITS.length))
  const [smallest = 's', step = 1000] = shown.at(-1) ?? []
  let left = round(total / step) * step
  const parts: string[] = []
  for (const [name, size] of shown) {
    const n = Math.floor(left / size)
    left -= n * size
    if (n) parts.push(`${n}${name}`)
  }
  return parts.slice(0, units).join(' ') || `0${smallest}`
}

export const formatAgo = (ts: number, now = Date.now()): string =>
  now - ts < 60_000 ? 'just now' : `${formatDuration(now - ts)} ago`
