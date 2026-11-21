import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'
import { tick, withMessage } from './helpers/fakes.ts'

import { appliedMigrations } from '../scripts/lib/migrations.ts'
import { policyFor } from '../scripts/lib/policy.ts'
import { configureSpaces, membersOf, spaceOf } from '../scripts/lib/spaces.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

describe('Spaces', () => {
  const state = setupRobot(['DisableBuiltinHelp.ts', 'Policy.ts', 'Spaces.ts', 'Seen.ts', 'Kudos.ts', 'Wins.ts', 'Roles.ts'], { envVars: ['LEGACY_GUILD_ID'] })

  beforeEach(() => {
    delete process.env.LEGACY_GUILD_ID
    setRandomSource(() => 0)
    policyFor(state.robot).update(d => {
      d.guilds.g1 = { mode: 'casual', on: [], off: [] }
      d.guilds.g2 = { mode: 'casual', on: [], off: [] }
    })
  })

  // guild null for a dm
  const say = async (id: string, name: string, text: string, room: string, guild: string | null) => {
    const user = withMessage(brainUser(state.robot, id, name), { guildId: guild, author: { id }, channel: { id: room, isThread: () => false } })
    await state.robot.adapter.say(user, text, room)
  }
  const bot = (text: string) => `@${state.robot.name} ${text}`

  it('places rooms in spaces', () => {
    configureSpaces({ unplaced: 'room' })
    const { robot } = state
    assert.strictEqual(spaceOf(robot, 'r', { guildId: 'g1', channel: { id: 'r' } }), 'g:g1')
    assert.strictEqual(spaceOf(robot, 'd', { guildId: null, author: { id: 'u1' } }), 'dm:u1')
    assert.strictEqual(spaceOf(robot, 'web:abc'), 'web')
    assert.strictEqual(spaceOf(robot, 'nowhere'), 'room:nowhere')
  })

  it('keeps scores, names and wins inside their server', async () => {
    const sent = collect(state.robot)
    await say('u2', 'bob', 'hello', 'a', 'g1')
    await say('u1', 'alice', 'pizza++', 'a', 'g1')
    await say('u1', 'alice', bot('kudos bob for the review'), 'a', 'g1')
    await say('u2', 'bob', bot('win shipped it'), 'a', 'g1')
    assert.match(sent.at(-2)!, /score: 1/)

    await say('u3', 'carol', bot('leaderboard'), 'b', 'g2')
    assert.strictEqual(sent.at(-1), 'No scores yet.')
    await say('u3', 'carol', bot('kudos bob'), 'b', 'g2')
    assert.strictEqual(sent.at(-1), "I don't know who bob is. Try mentioning them.")
    await say('u3', 'carol', bot('wins for bob'), 'b', 'g2')
    assert.strictEqual(sent.at(-1), "I don't know bob.")
    await say('u3', 'carol', bot('bob is a reviewer'), 'b', 'g2')
    assert.match(sent.at(-1)!, /bob/)
    assert.doesNotMatch(sent.at(-1)!, /^Ok/)

    await say('u1', 'alice', bot('leaderboard'), 'a', 'g1')
    assert.match(sent.at(-1)!, /pizza: 1/)
    await say('u1', 'alice', bot('wins for bob'), 'a', 'g1')
    assert.match(sent.at(-1)!, /shipped it/)
    assert.deepStrictEqual(Object.keys(membersOf(state.robot, 'g:g2')), ['u3'])
  })

  it('keeps roles per server', async () => {
    const sent = collect(state.robot)
    await say('u2', 'bob', 'hello', 'a', 'g1')
    await say('u2', 'bob', 'hello', 'b', 'g2')
    await say('u1', 'alice', bot('bob is a reviewer'), 'a', 'g1')
    assert.strictEqual(sent.at(-1), 'Ok, bob is a reviewer.')
    await say('u3', 'carol', bot('who is bob'), 'b', 'g2')
    assert.doesNotMatch(sent.at(-1)!, /reviewer/)
    await say('u3', 'carol', bot('who is bob'), 'a', 'g1')
    assert.strictEqual(sent.at(-1), 'bob is a reviewer.')
  })

  describe('migration', () => {
    const discord = (robot: TestRobot, guilds: string[], channels: Record<string, string>) => {
      const adapter = robot.adapter as unknown as { client?: Record<string, unknown> }
      const cache = new Map(Object.entries(channels).map(([id, guildId]) => [id, { id, guildId, isThread: () => false }]))
      adapter.client = { isReady: () => true, guilds: { cache: new Map(guilds.map(g => [g, {}])) }, channels: { cache, fetch: async () => { throw new Error('gone') } } }
    }

    const legacyBrain = (robot: TestRobot) => {
      robot.brain.set('plusplus:pizza', 3)
      robot.brain.set('praise:count', 7)
      robot.brain.set('streak:focus:u1', { current: 2, best: 2, lastDay: '2026-11-18' })
      robot.brain.set('log:win', [{ ts: 1, room: 'a', userId: 'u1', text: 'one' }, { ts: 2, room: 'b', userId: 'u2', text: 'two' }, { ts: 3, room: 'deleted', userId: 'u1', text: 'three' }])
      robot.brain.set('seen:u1', { name: 'alice', time: 5, where: { home: 5, other: 4 } })
      robot.brain.set('seen:u2', { name: 'bob', time: 6 })
      robot.brain.data.users.u1!.roles = ['captain']
    }

    it('moves global data into the one server, and logs to where they happened', async () => {
      const { robot } = state
      brainUser(robot, 'u1', 'alice')
      brainUser(robot, 'u2', 'bob')
      legacyBrain(robot)
      discord(robot, ['home'], { a: 'home', b: 'other' })
      robot.brain.emit('connected')
      await tick(10)
      assert.ok(appliedMigrations(robot)['002-spaces'])
      assert.strictEqual(robot.brain.get('g:home:plusplus:pizza'), 3)
      assert.strictEqual(robot.brain.get('g:home:praise:count'), 7)
      assert.ok(robot.brain.get('g:home:streak:focus:u1'))
      assert.strictEqual(robot.brain.get('plusplus:pizza'), null)
      assert.deepStrictEqual(robot.brain.get<{ text: string }[]>('g:home:log:win')!.map(e => e.text), ['one', 'three'])
      assert.deepStrictEqual(robot.brain.get<{ text: string }[]>('g:other:log:win')!.map(e => e.text), ['two'])
      assert.strictEqual(robot.brain.get('log:win'), null)
      assert.deepStrictEqual(membersOf(robot, 'g:home'), { u1: { name: 'alice', seen: 5 }, u2: { name: 'bob', seen: 6 } })
      assert.deepStrictEqual(membersOf(robot, 'g:other'), { u1: { name: 'alice', seen: 4 } })
      assert.strictEqual(robot.brain.get('seen:u1'), null)
      assert.deepStrictEqual(robot.brain.get('g:home:roles'), { u1: ['captain'] })
      assert.strictEqual(robot.brain.data.users.u1!.roles, undefined)
    })

    it('waits for LEGACY_GUILD_ID when in several servers', async () => {
      const { robot } = state
      brainUser(robot, 'u1', 'alice')
      legacyBrain(robot)
      discord(robot, ['home', 'other'], { a: 'home', b: 'other' })
      robot.brain.emit('connected')
      await tick(10)
      assert.strictEqual(appliedMigrations(robot)['002-spaces'], undefined)
      assert.strictEqual(robot.brain.get('plusplus:pizza'), 3)
      process.env.LEGACY_GUILD_ID = 'other'
      robot.brain.emit('connected')
      await tick(10)
      assert.strictEqual(robot.brain.get('g:other:plusplus:pizza'), 3)
    })
  })
})
