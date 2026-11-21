import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

describe('Weather', () => {
  const state = setupRobot('Weather.ts')

  for (const text of ['weather London', 'forecast for London']) {
    it(`reports temperature and conditions for "${text}"`, async () => {
      mockFetch((url: string) => url.includes('geocoding-api')
        ? { results: [{ name: 'London', country: 'United Kingdom', latitude: 51.5, longitude: -0.1 }] }
        : { current: { temperature_2m: 18.9, weather_code: 0 } })
      const { sent, ask } = chat(state)
      await ask(text)
      assert.strictEqual(sent[0], 'London, United Kingdom: 18.9°C, Clear sky')
    })
  }

  it('says when a city is not found', async () => {
    mockFetch({ results: [] })
    const { sent, ask } = chat(state)
    await ask('weather Nowhereville')
    assert.strictEqual(sent[0], "Couldn't find a place named Nowhereville.")
  })
})
