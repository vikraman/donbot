import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('GithubLink', () => {
  const state = setupRobot('GithubLink.ts', { envVars: ['OWNER_USER_ID'] })

  it('links an unclaimed account and announces it', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant my github is https://github.com/Alice-Dev/', 'room')
    assert.equal(sent[0], '🔗 <@u1> linked GitHub Alice-Dev. Pushes to repos I follow now count toward their commit streak.')
    assert.equal(robot.brain.get('github:login:u1'), 'Alice-Dev')
    await robot.adapter.say(user, '@Dumbotheelephant my github is alice2', 'room')
    assert.match(sent[1]!, /linked GitHub alice2 \(was Alice-Dev\)/)
    await robot.adapter.say(user, '@Dumbotheelephant my github', 'room')
    assert.equal(sent[2], "You're linked to GitHub alice2.")
  })
  it('refuses an account someone else claimed, case-insensitively', async () => {
    const { robot } = state
    const alice = brainUser(robot, 'u1', 'alice')
    const mallory = brainUser(robot, 'u2', 'mallory')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant my github is alice-dev', 'room')
    await robot.adapter.say(mallory, '@Dumbotheelephant my github is ALICE-DEV', 'room')
    assert.equal(sent[1], "GitHub ALICE-DEV is already linked to <@u1>. If that's wrong, ask my owner to sort it out.")
    assert.equal(robot.brain.get('github:login:u2'), null)
  })
  it('rejects things that are not github usernames', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant my github is -bad--name-', 'room')
    assert.match(sent[0]!, /doesn't look like a GitHub username/)
  })
  it('forgets on request', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant forget my github', 'room')
    assert.equal(sent[0], 'No GitHub account was linked.')
    await robot.adapter.say(user, '@Dumbotheelephant my github is alice', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant forget my github', 'room')
    assert.equal(sent[2], 'Unlinked GitHub alice.')
    await robot.adapter.say(user, '@Dumbotheelephant my github', 'room')
    assert.match(sent[3]!, /^No GitHub account linked/)
  })
  it('lets only the owner link and unlink for others, moving a claimed account', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'boss'
    const owner = brainUser(robot, 'boss', 'owner')
    const alice = brainUser(robot, 'u1', 'alice')
    brainUser(robot, '222', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, '@Dumbotheelephant my github is bobby', 'room')
    await robot.adapter.say(alice, '@Dumbotheelephant github link bob bobby', 'room')
    assert.equal(sent[1], 'Only my owner can link accounts for other people.')
    await robot.adapter.say(owner, '@Dumbotheelephant github link <@222> bobby', 'room')
    assert.equal(sent[2], '🔗 Linked <@222> to GitHub bobby, unlinking <@u1>.')
    assert.equal(robot.brain.get('github:login:u1'), null)
    await robot.adapter.say(owner, '@Dumbotheelephant github unlink bob', 'room')
    assert.equal(sent[3], 'Unlinked <@222> from GitHub bobby.')
  })
})
