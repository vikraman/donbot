import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { clock } from './helpers/fakes.ts'

// mon 2026-11-16 10:00 utc
const NOW = Date.UTC(2026, 10, 16, 10, 0)

describe('Timezone', () => {
  const state = setupRobot('Timezone.ts', { envVars: ['DEFAULT_TIMEZONE'] })

  it('sets a timezone, canonicalizing the name', async () => {
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    await ask('my timezone is america/new_york')
    assert.strictEqual(sent[0], "Got it, your timezone is America/New_York. It's 5am on Mon, Nov 16 for you.")
    assert.strictEqual(robot.brain.get('tz:user:test-user'), 'America/New_York')
  })
  it('rejects unknown zones', async () => {
    const { robot, sent, ask } = chat(state)
    await ask('my timezone is Mars/Olympus')
    assert.match(sent[0]!, /don't know the timezone "Mars\/Olympus"/)
    assert.strictEqual(robot.brain.get('tz:user:test-user'), null)
  })
  it('shows your timezone, the default when unset', async () => {
    process.env.DEFAULT_TIMEZONE = 'Europe/Paris'
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    await ask('my timezone')
    assert.strictEqual(sent[0], "Your timezone is Europe/Paris. It's 11am on Mon, Nov 16 for you.")
    robot.brain.set('tz:user:test-user', 'Europe/London')
    await ask("what's my timezone?")
    assert.strictEqual(sent[1], "Your timezone is Europe/London. It's 10am on Mon, Nov 16 for you.")
  })
  it('shows the local time for someone else', async () => {
    clock(NOW)
    const { robot, sent, ask } = chat(state)
    brainUser(robot, 'bob-id', 'bob')
    brainUser(robot, '12345', 'carol')
    robot.brain.set('tz:user:bob-id', 'Asia/Tokyo')
    await ask('time for bob')
    await ask('what time is it for <@12345>?')
    await ask('time for nobody')
    assert.deepStrictEqual(sent, [
      "It's 7pm on Mon, Nov 16 for <@bob-id> (Asia/Tokyo).",
      "It's 10am on Mon, Nov 16 for <@12345>.",
      "I don't know anyone called nobody."
    ])
  })
})
