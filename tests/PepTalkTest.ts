import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { isFrustrated, ROOM_COOLDOWN_MS, USER_COOLDOWN_MS } from '../scripts/PepTalk.ts'
import { setupRobot, chat, brainUser, inGuild } from './helpers/setup.ts'
import { clock } from './helpers/fakes.ts'

describe('PepTalk', () => {
  const state = setupRobot(['PepTalk.ts', 'Policy.ts'], { owner: 'u1' })
  const alice = () => chat(state, { id: 'u1', name: 'alice', room: 'room' })

  it('spots frustration', () => {
    assert.strictEqual(isFrustrated('ugh the build is broken again'), true)
    assert.strictEqual(isFrustrated("why won't this compile"), true)
    assert.strictEqual(isFrustrated('lunch at noon?'), false)
  })
  it('toggles per channel, then stays quiet when off', async () => {
    const { robot, sent, say, ask } = alice()
    inGuild(robot, 'g1', ['room'], 'casual')
    await ask('pep talks')
    await ask('pep talks off')
    for (let i = 0; i < 4; i++) await say('ugh still stuck')
    await ask('pep talks on')
    assert.deepStrictEqual(sent, ['Pep talks: on here.', 'Pep talks: off for this channel.', 'Pep talks: on for this channel.'])
  })
  it('stays quiet in a professional server', async () => {
    const { robot, sent, say } = alice()
    inGuild(robot, 'g2', ['room'])
    for (let i = 0; i < 4; i++) await say('ugh still stuck')
    assert.deepStrictEqual(sent, [])
  })
  it('sends one pep talk after three frustrated messages, then cools down', async () => {
    const t = clock()
    const { robot, sent, say } = alice()
    const bob = brainUser(robot, 'u2', 'bob')
    for (const text of ['ugh', 'this is fine', 'still stuck']) await say(text)
    assert.deepStrictEqual(sent, [])
    await say('tests failing again')
    assert.strictEqual(sent.length, 1)
    assert.match(sent[0]!, /^<@u1> /)
    for (let i = 0; i < 3; i++) await say('ugh broken')
    // room cooldown blocks bob too
    for (let i = 0; i < 3; i++) await say('ugh broken', { user: bob })
    assert.strictEqual(sent.length, 1)
    t.advance(ROOM_COOLDOWN_MS + 1)
    for (let i = 0; i < 3; i++) await say('ugh broken', { user: bob })
    assert.strictEqual(sent.length, 2)
    assert.ok(USER_COOLDOWN_MS > ROOM_COOLDOWN_MS)
  })
  it('gives pep talks on demand', async () => {
    const { robot, sent, ask } = alice()
    brainUser(robot, 'u2', 'bob')
    await ask('pep talk')
    await ask('pep talk for bob')
    await ask('pep talk <@99>')
    assert.deepStrictEqual(sent.map(s => s.split(' ')[0]), ['<@u1>', '<@u2>', '<@99>'])
  })
})
