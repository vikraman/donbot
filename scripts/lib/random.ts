import crypto from 'node:crypto'

import type { Robot } from 'hubot'

export const secureRandomInt = (min: number, max: number): number => crypto.randomInt(min, max + 1)

// 30 bits: the most random.org allows per value (range cap is 2e9)
const POOL_VALUE_CEILING = 2 ** 30
const POOL_KEY = 'random:pool'
const POOL_SIZE = 256
const POOL_LOW_WATER = 64
const POOL_RETRY_AFTER_FAILURE_MS = 5 * 60 * 1000

interface Pool {
  values: number[]
  // set only when a refill fails, to back off from a broken api
  failedAt: number
}

const isPool = (value: unknown): value is Pool =>
  typeof value === 'object' && value !== null &&
  Array.isArray((value as Pool).values) &&
  typeof (value as Pool).failedAt === 'number'

// the robot the pool draws against; set once at startup, absent in unit tests
let poolRobot: Robot | null = null
let refilling = false

const readPool = (): Pool => {
  if (!poolRobot) return { values: [], failedAt: 0 }
  const stored = poolRobot.brain.get(POOL_KEY)
  return isPool(stored) ? stored : { values: [], failedAt: 0 }
}

const writePool = (pool: Pool) => {
  poolRobot?.brain.set(POOL_KEY, { ...pool, values: pool.values.slice(0, POOL_SIZE) })
}

// fire-and-forget; callers never wait on the network
const refillPool = (pool: Pool) => {
  const apiKey = process.env.RANDOM_ORG_API_KEY
  if (!apiKey || refilling || !poolRobot) return
  if (Date.now() - pool.failedAt < POOL_RETRY_AFTER_FAILURE_MS) return

  refilling = true
  const wanted = POOL_SIZE - pool.values.length
  fetchFromRandomOrg(apiKey, wanted, 0, POOL_VALUE_CEILING - 1)
    .then(numbers => {
      const current = readPool()
      writePool({ values: [...current.values, ...numbers], failedAt: 0 })
    })
    .catch((error: unknown) => {
      // logged, not swallowed: the fallback is silent and would hide an outage
      poolRobot?.logger.warn(`random.org refill failed: ${String(error)}`)
      writePool({ ...readPool(), failedAt: Date.now() })
    })
    .finally(() => { refilling = false })
}

// lets tests drive every helper from one deterministic source
let source: ((ceiling: number) => number) | null = null

export const setRandomSource = (fn: ((ceiling: number) => number) | null) => { source = fn }

// one uniform value in [0, ceiling); true-random while the pool has stock
const drawBelow = (ceiling: number): number => {
  if (source) return source(ceiling)

  const pool = readPool()
  if (pool.values.length <= POOL_LOW_WATER) refillPool(pool)

  const value = pool.values[0]
  if (value === undefined) return secureRandomInt(0, ceiling - 1)

  writePool({ ...pool, values: pool.values.slice(1) })
  // modulo bias is negligible here: ceiling is tiny next to 2^30
  return value % ceiling
}

// call once at startup so the sync helpers can reach the brain
export const useRandomPool = (robot: Robot) => {
  poolRobot = robot
  refillPool(readPool())
}

// non-empty arrays always yield; dynamic ones must be checked
export function pick<T> (options: readonly [T, ...T[]]): T
export function pick<T> (options: readonly T[]): T | undefined
export function pick<T> (options: readonly T[]): T | undefined {
  if (options.length === 0) return undefined
  return options[drawBelow(options.length)]
}

export const shuffle = <T>(array: readonly T[]): T[] => {
  const copy = [...array]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = drawBelow(i + 1);
    // both indices in-bounds by construction
    [copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

const CHANCE_RESOLUTION = 1_000_000

export const chance = (probability: number): boolean =>
  drawBelow(CHANCE_RESOLUTION) < probability * CHANCE_RESOLUTION

export const randomId = (): string =>
  `${Date.now()}-${drawBelow(POOL_VALUE_CEILING).toString(36)}`

const RANDOM_ORG_TIMEOUT_MS = 3000
const BUFFER_KEY = (min: number, max: number) => `random:buffer:${min}:${max}`
const BUFFER_REFILL_SIZE = 50
const BUFFER_MAX_SIZE = 200

interface RandomBuffer {
  values: number[]
}

const fetchWithTimeout = async (url: string, options: RequestInit): Promise<number[]> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RANDOM_ORG_TIMEOUT_MS)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    if (!response.ok) throw new Error(`random.org responded with ${response.status}`)
    const body = await response.json()
    if (body.error) throw new Error(`random.org error: ${body.error.message}`)
    return body.result.random.data
  } finally {
    clearTimeout(timer)
  }
}

const fetchFromRandomOrg = async (apiKey: string, count: number, min: number, max: number): Promise<number[]> => {
  const numbers = await fetchWithTimeout('https://api.random.org/json-rpc/4/invoke', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'generateIntegers',
      params: { apiKey, n: count, min, max, replacement: true },
      id: 1
    })
  })
  if (numbers.length !== count) throw new Error('unexpected random.org response')
  return numbers
}

const readBuffer = (robot: Robot, min: number, max: number): RandomBuffer =>
  robot.brain.get<RandomBuffer>(BUFFER_KEY(min, max)) || { values: [] }

const writeBuffer = (robot: Robot, min: number, max: number, values: number[]) =>
  robot.brain.set(BUFFER_KEY(min, max), { values: values.slice(0, BUFFER_MAX_SIZE) })

// true-random ints, buffered in the brain; falls back to local
export const randomInts = async (robot: Robot, count: number, min: number, max: number): Promise<number[]> => {
  const buffer = readBuffer(robot, min, max)
  if (buffer.values.length >= count) {
    const drawn = buffer.values.slice(0, count)
    writeBuffer(robot, min, max, buffer.values.slice(count))
    return drawn
  }

  const apiKey = process.env.RANDOM_ORG_API_KEY
  if (!apiKey) return Array.from({ length: count }, () => secureRandomInt(min, max))

  try {
    const fetchCount = Math.max(count, BUFFER_REFILL_SIZE)
    const numbers = await fetchFromRandomOrg(apiKey, fetchCount, min, max)
    writeBuffer(robot, min, max, numbers.slice(count))
    return numbers.slice(0, count)
  } catch {
    return Array.from({ length: count }, () => secureRandomInt(min, max))
  }
}

export const randomInt = async (robot: Robot, min: number, max: number): Promise<number> => {
  const [value] = await randomInts(robot, 1, min, max)
  // fall back rather than trust the length
  return value ?? secureRandomInt(min, max)
}
