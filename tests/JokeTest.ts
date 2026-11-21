import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat, inGuild } from './helpers/setup.ts'
import { mockFetch } from './helpers/fakes.ts'
import { policyFor } from '../scripts/lib/policy.ts'

const JOKEAPI = 'https://v2.jokeapi.dev/joke'
const BLACKLIST = '?blacklistFlags=nsfw,religious,political,racist,sexist,explicit'

describe('Joke', () => {
  const state = setupRobot('Joke.ts')

  it('fetches a dad joke as json', async () => {
    let headers: Record<string, string> = {}
    const urls = mockFetch((_url: string, init?: RequestInit) => {
      headers = init?.headers as Record<string, string>
      return { joke: 'Why did the chicken cross the road?' }
    })
    const { sent, ask } = chat(state)
    await ask('joke')
    assert.deepStrictEqual(urls, ['https://icanhazdadjoke.com/'])
    assert.strictEqual(headers.Accept, 'application/json')
    assert.deepStrictEqual(sent, ['Why did the chicken cross the road?'])
  })

  for (const [text, url, body, reply] of [
    ['tell me a joke', 'https://icanhazdadjoke.com/', { joke: 'Parallel lines.' }, 'Parallel lines.'],
    ['joke chuck', 'https://api.chucknorris.io/jokes/random', { value: 'Chuck counted to infinity.' }, 'Chuck counted to infinity.'],
    ['joke programming', `${JOKEAPI}/programming${BLACKLIST}`, { error: false, type: 'twopart', setup: 'Why?', delivery: 'Because.' }, 'Why? Because.'],
    ['tell me a pun joke', `${JOKEAPI}/pun${BLACKLIST}`, { error: false, type: 'single', joke: 'A pun.' }, 'A pun.'],
    ['joke coding', `${JOKEAPI}/Programming${BLACKLIST}`, { error: false, type: 'single', joke: 'A joke.' }, 'A joke.'],
    ['joke halloween', `${JOKEAPI}/Spooky${BLACKLIST}`, { error: false, type: 'single', joke: 'Boo.' }, 'Boo.']
  ] as const) {
    it(`answers "${text}"`, async () => {
      const urls = mockFetch(body)
      const { sent, ask } = chat(state)
      await ask(text)
      assert.deepStrictEqual(urls, [url])
      assert.deepStrictEqual(sent, [reply])
    })
  }

  for (const [name, text, opts, body] of [
    ['the request fails', 'joke', { ok: false }, {}],
    ['jokeapi returns an error', 'joke programming', {}, { error: true }]
  ] as const) {
    it(`has no joke when ${name}`, async () => {
      mockFetch(body, opts)
      const { sent, ask } = chat(state)
      await ask(text)
      assert.deepStrictEqual(sent, ["I don't have a joke for you right now."])
    })
  }

  it('says when a category is unknown', async () => {
    const { sent, ask } = chat(state)
    await ask('joke nonsense')
    assert.match(sent[0]!, /don't know the "nonsense" category/)
  })

  it('keeps dark jokes for channels that turned them on', async () => {
    const urls = mockFetch({ error: false, type: 'single', joke: 'A dark one-liner.' })
    const { robot, sent, ask } = chat(state)
    inGuild(robot, 'g1', ['test-room'], 'casual')
    inGuild(robot, 'g1', ['dark-room'], undefined, { nsfw: true })
    policyFor(robot).update(d => { d.channels['dark-room'] = { on: ['joke.dark'], off: [] } })
    await ask('tell me a dark joke')
    assert.match(sent[0]!, /don't know the "dark" category/)
    assert.doesNotMatch(sent[0]!.split('Try:')[1]!, /dark/)
    assert.deepStrictEqual(urls, [])
    await ask('tell me a dark joke', { room: 'dark-room' })
    assert.deepStrictEqual(urls, [`${JOKEAPI}/dark`])
    assert.strictEqual(sent[1], 'A dark one-liner.')
  })

  it('asks jokeapi for safe jokes in professional servers', async () => {
    const urls = mockFetch({ error: false, type: 'single', joke: 'A safe one.' })
    const { robot, ask } = chat(state)
    inGuild(robot, 'g2', ['pro-room'])
    await ask('joke misc', { room: 'pro-room' })
    assert.deepStrictEqual(urls, [`${JOKEAPI}/misc?safe-mode`])
  })
})
