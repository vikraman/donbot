import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'
import hubotHelp from 'hubot-help'

describe('DisableBuiltinHelp testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'DisableBuiltinHelp.mjs')
    await robot.loadFile('./scripts', 'Count.mjs')
    await hubotHelp(robot)
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should show comment-scraped commands instead of the built-in scaffolding', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant help', 'test-room')
    assert.match(sent[0], /count - Increments and returns the counter\./)
    assert.doesNotMatch(sent[0], /No commands registered/)
    assert.doesNotMatch(sent[0], /Show commands with prefix/)
  })
})
