import crypto from 'node:crypto'

export const pick = (options) => options[Math.floor(Math.random() * options.length)]

export const shuffle = (array) => {
  const copy = [...array]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

export const chance = (probability) => Math.random() < probability

export const randomId = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`

export const secureRandomInt = (min, max) => crypto.randomInt(min, max + 1)

const RANDOM_ORG_TIMEOUT_MS = 3000
const BUFFER_KEY = (min, max) => `random:buffer:${min}:${max}`
const BUFFER_REFILL_SIZE = 50
const BUFFER_MAX_SIZE = 200

const fetchWithTimeout = async (url, options) => {
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

const fetchFromRandomOrg = async (apiKey, count, min, max) => {
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

const readBuffer = (robot, min, max) => robot.brain.get(BUFFER_KEY(min, max)) || { values: [] }

const writeBuffer = (robot, min, max, values) =>
  robot.brain.set(BUFFER_KEY(min, max), { values: values.slice(0, BUFFER_MAX_SIZE) })

// draws count true-random integers in [min, max]; buffers surplus in the brain to
// cut down on random.org calls, falls back to secureRandomInt if the key is
// missing or the request fails
export const randomInts = async (robot, count, min, max) => {
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

export const randomInt = async (robot, min, max) => (await randomInts(robot, 1, min, max))[0]
