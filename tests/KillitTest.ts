import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { KILLIT_COOLDOWN_MS } from '../scripts/Killit.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

describe('Killit testing Hubot scripts', () => {
  const state = setupRobot('Killit.ts')

  it('should send the fire joke when the roll succeeds', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0 * c))
    const user = brainUser(robot, 'test-user', 'test user')
    let actual = ''
    robot.on('send', (_envelope, ...strings) => {
      actual = strings.join('')
    })
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(actual, 'Kill it, kill it with fire!')
  })
  it('should stay quiet when the roll fails', async () => {
    const { robot } = state
    setRandomSource(c => Math.floor(0.999 * c))
    const user = brainUser(robot, 'test-user', 'test user')
    let sent = false
    robot.on('send', () => { sent = true })
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(sent, false)
  })
  it('should stay quiet in a room within the cooldown', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    for (let i = 0; i < 5; i++) await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(sent.length, 1)
  })
  it('should still joke in another room during the cooldown', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'kill the process', 'room-1')
    await robot.adapter.say(user, 'kill the process', 'room-2')
    assert.strictEqual(sent.length, 2)
  })
  it('should joke again once the cooldown expires', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    const now = mock.method(Date, 'now', () => 1_000_000)
    await robot.adapter.say(user, 'kill the process', 'test-room')
    now.mock.mockImplementation(() => 1_000_000 + KILLIT_COOLDOWN_MS)
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(sent.length, 2)
  })
  it('should not start the cooldown when the roll fails', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    setRandomSource(c => Math.floor(0.999 * c))
    await robot.adapter.say(user, 'kill the process', 'test-room')
    setRandomSource(() => 0)
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.strictEqual(sent.length, 1)
  })
})
