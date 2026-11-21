import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import { discordMessage, withMessage } from './helpers/fakes.ts'

describe('FAQ', () => {
  const state = setupRobot('Faq.ts')

  // user in room of guild g1, staff can manage channels
  const say = async (id: string, text: string, { room = 'room', guild = 'g1', staff = false } = {}) => {
    const user = withMessage(brainUser(state.robot, id, id), discordMessage(room, id, { guild, manageChannels: staff }))
    await state.robot.adapter.say(user, `@${state.robot.name} ${text}`, room)
  }

  it('lets staff save and forget answers that anyone can recall, per server', async () => {
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
