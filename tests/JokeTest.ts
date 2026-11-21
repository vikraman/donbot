import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser, inGuild } from './helpers/setup.ts'
import { policyFor } from '../scripts/lib/policy.ts'

describe('Joke testing Hubot scripts', () => {
  const state = setupRobot('Joke.ts')

  it('should reply with a dad joke for "joke"', async () => {
    const { robot } = state
    let requestedUrl = ''
    let requestedHeaders: Record<string, string> | null = null
    mock.method(global, 'fetch', async (url: string, options: { headers: Record<string, string> }) => {
      requestedUrl = url
      requestedHeaders = options.headers
      return { ok: true, json: async () => ({ joke: 'Why did the chicken cross the road?' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke', 'test-room')
    assert.strictEqual(requestedUrl, 'https://icanhazdadjoke.com/')
    assert.strictEqual(requestedHeaders!.Accept, 'application/json')
    assert.strictEqual(sent[0], 'Why did the chicken cross the road?')
  })

  it('should support "tell me a joke" as an alternate phrasing', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({
      ok: true, json: async () => ({ joke: 'Parallel lines have so much in common. Too bad they will never meet.' })
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tell me a joke', 'test-room')
    assert.strictEqual(sent[0], 'Parallel lines have so much in common. Too bad they will never meet.')
    assert.strictEqual(sent.length, 1)
  })

  it('should say it has no joke when the request fails', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: false }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke', 'test-room')
    assert.strictEqual(sent[0], "I don't have a joke for you right now.")
  })

  it('should fetch a chuck norris joke for "joke chuck"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url: string) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ value: 'Chuck Norris counted to infinity. Twice.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke chuck', 'test-room')
    assert.strictEqual(requestedUrl, 'https://api.chucknorris.io/jokes/random')
    assert.strictEqual(sent[0], 'Chuck Norris counted to infinity. Twice.')
  })

  it('should fetch a two-part joke from jokeapi for "joke programming"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url: string) => {
      requestedUrl = url
      return {
        ok: true,
        json: async () => ({
          error: false,
          type: 'twopart',
          setup: 'Why does no one like SQLrillex?',
          delivery: 'He keeps dropping the database.'
        })
      }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke programming', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/programming?blacklistFlags=nsfw,religious,political,racist,sexist,explicit')
    assert.strictEqual(sent[0], 'Why does no one like SQLrillex? He keeps dropping the database.')
  })

  it('should support "tell me a <category> joke" phrasing', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url: string) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ error: false, type: 'single', joke: 'A pun.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tell me a pun joke', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/pun?blacklistFlags=nsfw,religious,political,racist,sexist,explicit')
    assert.strictEqual(sent[0], 'A pun.')
    assert.strictEqual(sent.length, 1)
  })

  it('keeps dark jokes for channels that turned them on', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url: string) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ error: false, type: 'single', joke: 'A dark one-liner.' }) }
    })
    inGuild(robot, 'g1', ['test-room'], 'casual')
    inGuild(robot, 'g1', ['dark-room'], undefined, { nsfw: true })
    policyFor(robot).update(d => { d.channels['dark-room'] = { on: ['joke.dark'], off: [] } })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tell me a dark joke', 'test-room')
    assert.match(sent[0]!, /don't know the "dark" category/)
    assert.doesNotMatch(sent[0]!.split('Try:')[1]!, /dark/)
    assert.strictEqual(requestedUrl, '')
    await robot.adapter.say(user, '@Dumbotheelephant tell me a dark joke', 'dark-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/dark')
    assert.strictEqual(sent[1], 'A dark one-liner.')
  })

  it('asks jokeapi for safe jokes in professional servers', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url: string) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ error: false, type: 'single', joke: 'A safe one.' }) }
    })
    inGuild(robot, 'g2', ['pro-room'])
    const user = brainUser(robot, 'test-user', 'test user')
    await robot.adapter.say(user, '@Dumbotheelephant joke misc', 'pro-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/misc?safe-mode')
  })

  it('should resolve category aliases like "coding" and "halloween"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url: string) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ error: false, type: 'single', joke: 'A joke.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke coding', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/Programming?blacklistFlags=nsfw,religious,political,racist,sexist,explicit')
    await robot.adapter.say(user, '@Dumbotheelephant joke halloween', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/Spooky?blacklistFlags=nsfw,religious,political,racist,sexist,explicit')
  })

  it('should say when a category is unknown', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke nonsense', 'test-room')
    assert.match(sent[0]!, /don't know the "nonsense" category/)
  })

  it('should say it has no joke when jokeapi returns an error payload', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ error: true }) }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke programming', 'test-room')
    assert.strictEqual(sent[0], "I don't have a joke for you right now.")
  })
})
