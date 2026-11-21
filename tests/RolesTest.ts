import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { withMessage } from './helpers/fakes.ts'

import { policyFor } from '../scripts/lib/policy.ts'
import { learnMember } from '../scripts/lib/spaces.ts'

describe('Roles', () => {
  const state = setupRobot('Roles.ts')

  it('assigns, reports and removes roles', async () => {
    const { ask, sent } = chat(state, { id: 'author-id', name: 'author' })
    brainUser(state.robot, 'holman-id', 'holman')
    await ask('holman is an ego surfer')
    await ask('who is holman')
    await ask('holman is not an ego surfer')
    assert.deepStrictEqual(sent, ['Ok, holman is an ego surfer.', 'holman is an ego surfer.', 'Ok, holman is no longer an ego surfer.'])
  })

  it('says it knows nothing of unknown users or roleless ones', async () => {
    const { ask, sent } = chat(state, { id: 'author-id', name: 'author' })
    brainUser(state.robot, 'holman-id', 'holman')
    await ask('nobody is a mystery')
    await ask('who is holman')
    assert.match(sent[0]!, /nobody/)
    assert.match(sent[1]!, /holman/)
    assert.doesNotMatch(sent.join('\n'), /^Ok/m)
  })

  it('leaves phrases owned by other scripts alone', async () => {
    const { ask, sent } = chat(state, { id: 'author-id', name: 'author' })
    for (const text of [
      'who is focusing?',
      'who is your owner',
      'my timezone is Europe/London',
      'what time is it for holman',
      'my github is holman',
      'remind me tomorrow at 9am to check the build is green',
      'win the deploy is done',
      'focus on why the build is red',
      'kudos bob for the fix that is great',
      'pep talk bob is sad'
    ]) await ask(text)
    assert.deepStrictEqual(sent, [])
  })
})

describe('Roles in professional servers', () => {
  const state = setupRobot('Roles.ts')

  // a message in guild g1, with or without manage roles
  const ask = async (id: string, text: string, manageRoles = false) => {
    const user = brainUser(state.robot, id, id === 'u1' ? 'alice' : 'bob')
    const perms = { has: (flag: string) => manageRoles && flag === 'ManageRoles' }
    withMessage(user, { guildId: 'g1', author: { id }, member: { permissions: perms }, channel: { id: 'room', isThread: () => false } })
    await state.robot.adapter.say(user, `@${state.robot.name} ${text}`, 'room')
  }

  it('needs manage roles to set roles, but not to ask', async () => {
    const { robot } = state
    learnMember(robot, 'g:g1', 'u2', 'bob')
    const { sent } = chat(state)
    await ask('u1', 'bob is a TA')
    assert.strictEqual(sent.at(-1), 'In professional servers, only someone who can manage roles can do that.')
    await ask('u1', 'bob is a TA', true)
    assert.strictEqual(sent.at(-1), 'Ok, bob is a TA.')
    await ask('u1', 'who is bob')
    assert.strictEqual(sent.at(-1), 'bob is a TA.')
    policyFor(robot).update(d => { d.guilds.g1 = { mode: 'casual', on: [], off: [] } })
    await ask('u1', 'bob is not a TA')
    assert.strictEqual(sent.at(-1), 'Ok, bob is no longer a TA.')
  })
})
