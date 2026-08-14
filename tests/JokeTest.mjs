import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Joke testing Hubot scripts', () => {
  const state = setupRobot('Joke.mjs')

  it('should reply with a dad joke for "joke"', async () => {
    const { robot } = state
    let requestedUrl = ''
    let requestedHeaders = null
    mock.method(global, 'fetch', async (url, options) => {
      requestedUrl = url
      requestedHeaders = options.headers
      return { ok: true, json: async () => ({ joke: 'Why did the chicken cross the road?' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke', 'test-room')
    assert.strictEqual(requestedUrl, 'https://icanhazdadjoke.com/')
    assert.strictEqual(requestedHeaders.Accept, 'application/json')
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
    mock.method(global, 'fetch', async (url) => {
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
    mock.method(global, 'fetch', async (url) => {
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
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/programming')
    assert.strictEqual(sent[0], 'Why does no one like SQLrillex? He keeps dropping the database.')
  })

  it('should support "tell me a <category> joke" phrasing', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ error: false, type: 'single', joke: 'A dark one-liner.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tell me a dark joke', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/dark')
    assert.strictEqual(sent[0], 'A dark one-liner.')
    assert.strictEqual(sent.length, 1)
  })

  it('should resolve category aliases like "coding" and "halloween"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ error: false, type: 'single', joke: 'A joke.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke coding', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/Programming')
    await robot.adapter.say(user, '@Dumbotheelephant joke halloween', 'test-room')
    assert.strictEqual(requestedUrl, 'https://v2.jokeapi.dev/joke/Spooky')
  })

  it('should say when a category is unknown', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke nonsense', 'test-room')
    assert.match(sent[0], /don't know the "nonsense" category/)
  })

  it('should say it has no joke when jokeapi returns an error payload', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ error: true }) }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant joke dark', 'test-room')
    assert.strictEqual(sent[0], "I don't have a joke for you right now.")
  })
})
