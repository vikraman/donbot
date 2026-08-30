import crypto from 'node:crypto'

import type { Robot } from 'hubot'

// non-empty arrays always yield; dynamic ones must be checked
export function pick<T> (options: readonly [T, ...T[]]): T
export function pick<T> (options: readonly T[]): T | undefined
export function pick<T> (options: readonly T[]): T | undefined {
  return options[Math.floor(Math.random() * options.length)]
}

export const shuffle = <T>(array: readonly T[]): T[] => {
  const copy = [...array]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    // both indices in-bounds by construction
    [copy[i], copy[j]] = [copy[j]!, copy[i]!]
  }
  return copy
}

export const chance = (probability: number): boolean => Math.random() < probability

export const randomId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2)}`

export const secureRandomInt = (min: number, max: number): number => crypto.randomInt(min, max + 1)

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
