import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'

describe('Xkcd', () => {
  const state = setupRobot('Xkcd.ts')

  for (const [text, url] of [
    ['xkcd', 'https://xkcd.com/info.0.json'],
    ['xkcd comic', 'https://xkcd.com/info.0.json'],
    ['xkcd 1', 'https://xkcd.com/1/info.0.json']
  ] as const) {
    it(`fetches ${url} for "${text}"`, async () => {
      const urls = mockFetch({ title: 'Size and Lifespan', img: 'https://imgs.xkcd.com/comics/size_and_lifespan.png' })
      const { sent, ask } = chat(state)
      await ask(text)
      assert.deepStrictEqual(urls, [url])
      assert.strictEqual(sent[0], 'Size and Lifespan: https://imgs.xkcd.com/comics/size_and_lifespan.png')
    })
  }

  it('fetches a random comic within the latest range', async () => {
    const urls = mockFetch((url: string) => url === 'https://xkcd.com/info.0.json'
      ? { num: 100, title: 'Latest', img: 'https://imgs.xkcd.com/comics/latest.png' }
      : { title: 'Random Comic', img: 'https://imgs.xkcd.com/comics/random.png' })
    const { sent, ask } = chat(state)
    await ask('xkcd random')
    const number = Number(urls[1]!.match(/^https:\/\/xkcd\.com\/(\d+)\/info\.0\.json$/)![1])
    assert.ok(number >= 1 && number <= 100)
    assert.strictEqual(sent[0], 'Random Comic: https://imgs.xkcd.com/comics/random.png')
  })
})
