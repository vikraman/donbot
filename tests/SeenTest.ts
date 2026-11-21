import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'

describe('Seen', () => {
  const state = setupRobot('Seen.ts', { envVars: ['OWNER_USER_ID'] })
  const author = () => chat(state, { id: 'author-id', name: 'author' })

  it('says it has not seen an unknown user', async () => {
    const { sent, ask } = author()
    await ask('seen nobody')
    assert.deepStrictEqual(sent, ["I haven't seen nobody here."])
  })
  for (const phrase of ['seen', 'have you seen']) {
    it(`reports when someone last spoke for "${phrase}"`, async () => {
      const { sent, say, ask } = author()
      await say('hello there', { user: { id: 'holman-id', name: 'holman' } })
      await ask(`${phrase} holman`)
      assert.match(sent[0]!, /^holman was last seen /)
    })
  }
  it('registers and renames speakers in the brain just from them talking', async () => {
    const { robot, say } = author()
    const user = { id: 'renamed-id', name: 'oldname' }
    await say('hello there', { user })
    assert.strictEqual(robot.brain.data.users['renamed-id']!.name, 'oldname')
    user.name = 'newname'
    await say('hello again', { user })
    assert.strictEqual(robot.brain.data.users['renamed-id']!.name, 'newname')
  })
  it('lists everyone it has seen talk', async () => {
    const { sent, say, ask } = author()
    await ask('who do you know')
    assert.strictEqual(sent[0], 'I know 1 person: author')
    await say('hello there', { user: { id: 'holman-id', name: 'holman' } })
    await ask('who do you know')
    assert.match(sent[1]!, /^I know 2 people: /)
    assert.match(sent[1]!, /\bauthor\b/)
    assert.match(sent[1]!, /\bholman\b/)
  })
  it('says when it has no owner configured, or has not heard from them', async () => {
    const { sent, ask } = author()
    await ask('who is your owner')
    process.env.OWNER_USER_ID = 'owner-id'
    await ask('who is your owner')
    assert.deepStrictEqual(sent, ["I don't have an owner configured.", "My owner hasn't said anything yet, so I don't know their name."])
  })
  for (const phrase of ['who is your owner', 'who made you']) {
    it(`names the owner once known for "${phrase}"`, async () => {
      process.env.OWNER_USER_ID = 'owner-id'
      const { sent, say, ask } = author()
      await say('hello', { user: { id: 'owner-id', name: 'vikraman' } })
      await ask(phrase)
      assert.deepStrictEqual(sent, ['vikraman owns me.'])
    })
  }
})
