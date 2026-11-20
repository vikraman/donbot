import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { isFrustrated, ROOM_COOLDOWN_MS, USER_COOLDOWN_MS } from '../scripts/PepTalk.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, collect, brainUser, inGuild } from './helpers/setup.ts'

describe('PepTalk', () => {
  const state = setupRobot(['PepTalk.ts', 'Policy.ts'], { envVars: ['OWNER_USER_ID'] })

  it('spots frustration', () => {
    assert.equal(isFrustrated('ugh the build is broken again'), true)
    assert.equal(isFrustrated("why won't this compile"), true)
    assert.equal(isFrustrated('lunch at noon?'), false)
  })
  it('toggles per channel', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'u1'
    inGuild(robot, 'g1', ['room'], 'casual')
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant pep talks', 'room')
    assert.equal(sent[0], 'Pep talks: on here.')
    await robot.adapter.say(user, '@Dumbotheelephant pep talks off', 'room')
    assert.equal(sent[1], 'Pep talks: off for this channel.')
    await robot.adapter.say(user, '@Dumbotheelephant pep talks on', 'room')
    assert.equal(sent[2], 'Pep talks: on for this channel.')
    assert.equal(sent.length, 3)
  })
  it('stays quiet when turned off', async () => {
    const { robot } = state
    process.env.OWNER_USER_ID = 'u1'
    inGuild(robot, 'g1', ['room'], 'casual')
    const user = brainUser(robot, 'u1', 'alice')
    await robot.adapter.say(user, '@Dumbotheelephant pep talks off', 'room')
    const sent = collect(robot)
    for (let i = 0; i < 4; i++) await robot.adapter.say(user, 'ugh still stuck', 'room')
    assert.deepEqual(sent, [])
  })
  it('stays quiet in a professional server', async () => {
    const { robot } = state
    inGuild(robot, 'g2', ['room'])
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    for (let i = 0; i < 4; i++) await robot.adapter.say(user, 'ugh still stuck', 'room')
    assert.deepEqual(sent, [])
  })
  it('sends one pep talk after three frustrated messages, then cools down', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    const alice = brainUser(robot, 'u1', 'alice')
    const bob = brainUser(robot, 'u2', 'bob')
    const sent = collect(robot)
    await robot.adapter.say(alice, 'ugh', 'room')
    await robot.adapter.say(alice, 'this is fine', 'room')
    await robot.adapter.say(alice, 'still stuck', 'room')
    assert.deepEqual(sent, [])
    await robot.adapter.say(alice, 'tests failing again', 'room')
    assert.deepEqual(sent, ["<@u1> you've figured out harder things than this. Take a breather, it'll click."])
    for (let i = 0; i < 3; i++) await robot.adapter.say(alice, 'ugh broken', 'room')
    // room cooldown blocks bob too
    for (let i = 0; i < 3; i++) await robot.adapter.say(bob, 'ugh broken', 'room')
    assert.equal(sent.length, 1)
    const start = Date.now()
    mock.method(Date, 'now', () => start + ROOM_COOLDOWN_MS + 1)
    for (let i = 0; i < 3; i++) await robot.adapter.say(bob, 'ugh broken', 'room')
    assert.equal(sent.length, 2)
    assert.ok(USER_COOLDOWN_MS > ROOM_COOLDOWN_MS)
  })
  it('gives pep talks on demand', async () => {
    const { robot } = state
    setRandomSource(() => 0)
    brainUser(robot, 'u2', 'bob')
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant pep talk', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant pep talk for bob', 'room')
    await robot.adapter.say(user, '@Dumbotheelephant pep talk <@99>', 'room')
    assert.deepEqual(sent.map(s => s.split(' ')[0]), ['<@u1>', '<@u2>', '<@99>'])
  })
  it('does not repeat a pep talk back to back', async () => {
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    for (let i = 0; i < 40; i++) await robot.adapter.say(user, '@Dumbotheelephant pep talk', 'room')
    sent.forEach((s, i) => { if (i) assert.notEqual(s, sent[i - 1]) })
    assert.ok(sent.every(s => s.startsWith('<@u1> ')))
  })
})
