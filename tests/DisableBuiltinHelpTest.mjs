import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import hubotHelp from 'hubot-help'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

describe('DisableBuiltinHelp testing Hubot scripts', () => {
  const state = setupRobot(['DisableBuiltinHelp.mjs', 'Count.mjs'])
  beforeEach(async () => { await hubotHelp(state.robot) })

  it('should show comment-scraped commands instead of the built-in scaffolding', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant help', 'test-room')
    assert.match(sent[0], /count - Increments and returns the counter\./)
    assert.doesNotMatch(sent[0], /No commands registered/)
    assert.doesNotMatch(sent[0], /Show commands with prefix/)
  })
})
