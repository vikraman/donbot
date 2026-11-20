import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'

// a message from user in room of guild g1, with or without Manage Channels
const sayer = (robot: TestRobot) => async (id: string, text: string, { room = 'room', guild = 'g1', staff = false } = {}) => {
  const user = brainUser(robot, id, id)
  const perms = { has: (flag: string) => staff && flag === 'ManageChannels' }
  ;(user as unknown as { message: unknown }).message = { guildId: guild, author: { id }, member: { permissions: { has: () => false } }, channel: { id: room, isThread: () => false, permissionsFor: () => perms } }
  await robot.adapter.say(user, `@${robot.name} ${text}`, room)
}

describe('FAQ', () => {
  const state = setupRobot('Faq.ts')

  it('lets staff save and forget answers that anyone can recall, per server', async () => {
    const say = sayer(state.robot)
    const sent = collect(state.robot)
    await say('u2', 'faq install is see the wiki')
    assert.strictEqual(sent.at(-1), 'Only someone who can manage this channel can do that.')
    await say('u1', 'faq Install is Run `make setup`, then see the wiki.', { staff: true })
    assert.match(sent.at(-1)!, /^Saved `install`/)
    await say('u2', 'faq install')
    assert.strictEqual(sent.at(-1), 'Run `make setup`, then see the wiki.')
    await say('u2', 'faqs')
    assert.strictEqual(sent.at(-1), 'Saved answers: `install`')
    await say('u3', 'faq install', { guild: 'g2', room: 'elsewhere' })
    assert.match(sent.at(-1)!, /no answer called `install`/)
    await say('u1', 'forget faq install', { staff: true })
    assert.strictEqual(sent.at(-1), 'Forgot `install`.')
    await say('u2', 'faqs')
    assert.strictEqual(sent.at(-1), 'No saved answers here yet.')
  })
})
