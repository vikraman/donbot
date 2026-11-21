import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

describe('Pugme', () => {
  const state = setupRobot('Pugme.ts')

  for (const text of ['pug me', 'show me a pug']) {
    it(`sends the image url for "${text}"`, async () => {
      mockFetch({ message: 'https://images.dog.ceo/breeds/pug/example.jpg', status: 'success' })
      const { sent, ask } = chat(state)
      await ask(text)
      assert.strictEqual(sent[0], 'https://images.dog.ceo/breeds/pug/example.jpg')
    })
  }
})
