import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { pick, shuffle, chance, randomId, secureRandomInt, randomInt, randomInts, useRandomPool } from '../scripts/lib/random.ts'

import type { Robot } from 'hubot'

import { fc } from './helpers/arb.ts'

interface RandomOrgRequest {
  params: { n: number }
}

interface Buffer { values: number[] }
interface Pool { values: number[], failedAt: number }

// randomInt/randomInts only touch robot.brain.get/set
const fakeRobot = (): Robot => {
  const data: Record<string, unknown> = {}
  return {
    brain: {
      get: (key: string) => data[key],
      set: (key: string, value: unknown) => { data[key] = value }
    }
  } as unknown as Robot
}

describe('random lib', () => {
  it('pick returns a member of the array', () => {
    fc.assert(fc.property(fc.array(fc.integer(), { minLength: 1 }), xs => { assert.ok(xs.includes(pick(xs)!)) }))
  })

  it('shuffle returns a permutation, leaving the input alone', () => {
    fc.assert(fc.property(fc.array(fc.integer()), xs => {
      const copy = [...xs]
      assert.deepStrictEqual([...shuffle(xs)].sort(), [...xs].sort())
      assert.deepStrictEqual(xs, copy)
    }))
  })

  it('chance(0) is always false and chance(1) is always true', () => {
    for (let i = 0; i < 20; i++) {
      assert.strictEqual(chance(0), false)
      assert.strictEqual(chance(1), true)
    }
  })

  it('randomId returns distinct strings', () => {
    const a = randomId()
    const b = randomId()
    assert.notStrictEqual(a, b)
  })

  it('secureRandomInt stays within bounds', () => {
    for (let i = 0; i < 50; i++) {
      const n = secureRandomInt(1, 6)
      assert.ok(n >= 1 && n <= 6)
    }
  })
})

describe('randomInt/randomInts', () => {
  let originalKey: string | undefined
  beforeEach(() => { originalKey = process.env.RANDOM_ORG_API_KEY })
  afterEach(() => {
    if (originalKey === undefined) delete process.env.RANDOM_ORG_API_KEY
    else process.env.RANDOM_ORG_API_KEY = originalKey
    mock.reset()
  })

  it('skips fetch and falls back to secureRandomInt when no api key is set', async () => {
    delete process.env.RANDOM_ORG_API_KEY
    const fetchMock = mock.method(global, 'fetch', async () => { throw new Error('should not be called') })
    const robot = fakeRobot()
    const n = await randomInt(robot, 1, 6)
    assert.ok(n >= 1 && n <= 6)
    assert.strictEqual(fetchMock.mock.calls.length, 0)
  })

  it('fetches from random.org and buffers the surplus', async () => {
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    const data = Array.from({ length: 50 }, (_, i) => i + 1)
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ({ result: { random: { data } } })
    }))
    const robot = fakeRobot()
    const [n] = await randomInts(robot, 1, 1, 100)
    assert.strictEqual(n, 1)
    const buffered = robot.brain.get<Buffer>('random:buffer:1:100')!
    assert.strictEqual(buffered.values.length, 49)
  })

  it('serves subsequent draws from the brain buffer without calling fetch again', async () => {
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    const data = Array.from({ length: 50 }, (_, i) => i + 1)
    const fetchMock = mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ({ result: { random: { data } } })
    }))
    const robot = fakeRobot()
    const [first] = await randomInts(robot, 1, 1, 100)
    assert.strictEqual(first, 1)
    assert.strictEqual(fetchMock.mock.calls.length, 1)
    const [second] = await randomInts(robot, 1, 1, 100)
    assert.strictEqual(second, 2)
    assert.strictEqual(fetchMock.mock.calls.length, 1)
  })

  it('falls back to secureRandomInt when the fetch fails', async () => {
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => { throw new Error('network down') })
    const robot = fakeRobot()
    const n = await randomInt(robot, 1, 6)
    assert.ok(n >= 1 && n <= 6)
  })

  it('falls back to secureRandomInt when the response signals an error', async () => {
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ({ error: { message: 'invalid key' } })
    }))
    const robot = fakeRobot()
    const n = await randomInt(robot, 1, 6)
    assert.ok(n >= 1 && n <= 6)
  })
})

// last, binds the pool for the file
describe('random pool', () => {
  let originalKey: string | undefined
  beforeEach(() => {
    originalKey = process.env.RANDOM_ORG_API_KEY
    process.env.RANDOM_ORG_API_KEY = 'test-key'
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env.RANDOM_ORG_API_KEY
    else process.env.RANDOM_ORG_API_KEY = originalKey
    mock.reset()
  })

  const poolRobot = (values: number[]) => {
    const robot = fakeRobot()
    const warn = mock.fn()
    Object.assign(robot, { logger: { warn } })
    robot.brain.set('random:pool', { values, failedAt: 0 })
    return { robot, warn }
  }

  const settle = () => new Promise(resolve => setImmediate(resolve))

  it('does not ask random.org for zero values when the pool is already full', async () => {
    const fetchMock = mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ({ error: { message: "Parameter 'n' is out of range" } })
    }))
    const { robot, warn } = poolRobot(Array.from({ length: 256 }, (_, i) => i))
    useRandomPool(robot)
    await settle()
    assert.strictEqual(fetchMock.mock.calls.length, 0)
    assert.strictEqual(warn.mock.calls.length, 0)
    assert.strictEqual(robot.brain.get<Pool>('random:pool')!.failedAt, 0)
  })

  it('tops up a partly drained pool with exactly the missing count', async () => {
    const fetchMock = mock.method(global, 'fetch', async (_url: string, init: RequestInit) => {
      const { n } = (JSON.parse(init.body as string) as RandomOrgRequest).params
      return { ok: true, json: async () => ({ result: { random: { data: Array.from({ length: n }, () => 7) } } }) }
    })
    const { robot, warn } = poolRobot(Array.from({ length: 200 }, (_, i) => i))
    useRandomPool(robot)
    await settle()
    assert.strictEqual(fetchMock.mock.calls.length, 1)
    assert.strictEqual((JSON.parse(fetchMock.mock.calls[0]!.arguments[1]!.body as string) as RandomOrgRequest).params.n, 56)
    assert.strictEqual(robot.brain.get<Pool>('random:pool')!.values.length, 256)
    assert.strictEqual(warn.mock.calls.length, 0)
  })
})
