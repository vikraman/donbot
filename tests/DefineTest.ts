import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('Define testing Hubot scripts', () => {
  const state = setupRobot('Define.ts')

  it('should report the first definition', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ([{ meanings: [{ partOfSpeech: 'exclamation', definitions: [{ definition: 'used as a greeting.' }] }] }])
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant define hello', 'test-room')
    assert.strictEqual(sent[0], 'hello (exclamation): used as a greeting.')
  })
  it('should support the "what does X mean" alternate phrasing', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({
      ok: true,
      json: async () => ([{ meanings: [{ partOfSpeech: 'exclamation', definitions: [{ definition: 'used as a greeting.' }] }] }])
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant what does hello mean', 'test-room')
    assert.strictEqual(sent[0], 'hello (exclamation): used as a greeting.')
  })
  it('should say when no definition is found', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async () => ({ ok: false }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant define zzzznotaword', 'test-room')
    assert.strictEqual(sent[0], 'No definition found for zzzznotaword.')
  })
})
