import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

const API = 'https://bender.sierrasoftworks.com/api/v1/quote'

describe('Futurama', () => {
  const state = setupRobot('Futurama.ts')

  for (const [text, url] of [
    ['quote', API],
    ['entertain me', API],
    ['quote Farnsworth', `${API}/Farnsworth`]
  ] as const) {
    it(`quotes with attribution for "${text}"`, async () => {
      const urls = mockFetch({ quote: 'Good news, everyone!', who: 'Professor Farnsworth' })
      const { sent, ask } = chat(state)
      await ask(text)
      assert.deepStrictEqual(urls, [url])
      assert.strictEqual(sent[0], '"Good news, everyone!" — Professor Farnsworth')
    })
  }

  it('says it has no quote when the character is not found', async () => {
    mockFetch(null, { ok: false })
    const { sent, ask } = chat(state)
    await ask('quote Donbot')
    assert.strictEqual(sent[0], "I don't have a quote for that.")
  })
})
