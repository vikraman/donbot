import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('Xkcd testing Hubot scripts', () => {
  const state = setupRobot('Xkcd.mjs')

  it('should fetch the latest comic when no number is given', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ title: 'Size and Lifespan', img: 'https://imgs.xkcd.com/comics/size_and_lifespan.png' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant xkcd', 'test-room')
    assert.strictEqual(requestedUrl, 'https://xkcd.com/info.0.json')
    assert.strictEqual(sent[0], 'Size and Lifespan: https://imgs.xkcd.com/comics/size_and_lifespan.png')
  })
  it('should fetch a specific comic number when given', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { ok: true, json: async () => ({ title: 'Barrel - Part 1', img: 'https://imgs.xkcd.com/comics/barrel_part_1.jpg' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant xkcd 1', 'test-room')
    assert.strictEqual(requestedUrl, 'https://xkcd.com/1/info.0.json')
  })
  it('should support "xkcd comic" as an alternate phrasing', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: true, json: async () => ({ title: 'Test', img: 'https://imgs.xkcd.com/comics/test.png' }) }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant xkcd comic', 'test-room')
    assert.strictEqual(sent[0], 'Test: https://imgs.xkcd.com/comics/test.png')
  })
  it('should fetch a random comic number within the latest range', async () => {
    const { robot } = state
    let requestedUrls = []
    mock.method(global, 'fetch', async (url) => {
      requestedUrls.push(url)
      if (url === 'https://xkcd.com/info.0.json') {
        return { ok: true, json: async () => ({ num: 100, title: 'Latest', img: 'https://imgs.xkcd.com/comics/latest.png' }) }
      }
      return { ok: true, json: async () => ({ title: 'Random Comic', img: 'https://imgs.xkcd.com/comics/random.png' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant xkcd random', 'test-room')
    assert.match(requestedUrls[1], /^https:\/\/xkcd\.com\/(\d+)\/info\.0\.json$/)
    const number = Number(requestedUrls[1].match(/\/(\d+)\/info\.0\.json$/)[1])
    assert.ok(number >= 1 && number <= 100)
    assert.strictEqual(sent[0], 'Random Comic: https://imgs.xkcd.com/comics/random.png')
  })
})
