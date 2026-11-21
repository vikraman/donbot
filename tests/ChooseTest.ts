import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

const randomOrg = (data: number[]) => mockFetch({ result: { random: { data } } })

describe('Choose', () => {
  const state = setupRobot('Choose.ts', { envVars: ['RANDOM_ORG_API_KEY'] })

  for (const [text, data, expected] of [
    ['choose pizza or tacos', Array<number>(50).fill(1), 'tacos'],
    ['pick pizza or tacos', Array<number>(50).fill(0), 'pizza'],
    ['roll a number between 1 and 100', Array<number>(50).fill(42), '42'],
    ['roll 3 numbers between 1 and 10', [3, 7, 9, ...Array<number>(47).fill(1)], '3, 7, 9']
  ] as const) {
    it(`answers "${text}" from random.org`, async () => {
      process.env.RANDOM_ORG_API_KEY = 'test-key'
      randomOrg([...data])
      const { sent, ask } = chat(state)
      await ask(text)
      assert.strictEqual(sent[0], expected)
    })
  }

  it('complains with fewer than two options', async () => {
    const { sent, ask } = chat(state)
    await ask('choose pizza')
    assert.match(sent[0]!, /at least two options/)
  })

  it('falls back to local randomness when random.org fails', async () => {
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(globalThis, 'fetch', async () => { throw new Error('network down') })
    const { sent, ask } = chat(state)
    await ask('choose pizza or tacos')
    assert.ok(['pizza', 'tacos'].includes(sent[0]!))
  })

  it('uses local randomness without an api key', async () => {
    delete process.env.RANDOM_ORG_API_KEY
    const urls = mockFetch({})
    const { sent, ask } = chat(state)
    await ask('choose pizza or tacos')
    assert.ok(['pizza', 'tacos'].includes(sent[0]!))
    assert.deepStrictEqual(urls, [])
  })
})
