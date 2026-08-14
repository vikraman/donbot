import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { pick, shuffle, chance, randomId, secureRandomInt, randomInt, randomInts } from '../scripts/lib/random.mjs'

const fakeRobot = () => {
  const data = {}
  return { brain: { get: key => data[key], set: (key, value) => { data[key] = value } } }
}

describe('random lib', () => {
  it('pick returns a member of the array', () => {
    const options = ['a', 'b', 'c']
    for (let i = 0; i < 20; i++) assert.ok(options.includes(pick(options)))
  })

  it('shuffle returns a permutation of the same elements', () => {
    const original = [1, 2, 3, 4, 5]
    const shuffled = shuffle(original)
    assert.deepStrictEqual([...shuffled].sort(), [...original].sort())
    assert.deepStrictEqual(original, [1, 2, 3, 4, 5])
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
  let originalKey
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
    const buffered = robot.brain.get('random:buffer:1:100')
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
