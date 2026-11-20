import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { User } from 'hubot'

import { setupRobot, collect, brainUser, inGuild } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'

import { configurePolicy, policyFor, POLICY_KEY } from '../scripts/lib/policy.ts'
import { appliedMigrations } from '../scripts/lib/migrations.ts'
import { postToRoom } from '../scripts/lib/rooms.ts'
import { membersOf } from '../scripts/lib/spaces.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

interface RawOptions {
  guild?: string | null
  manageGuild?: boolean
  manageChannels?: boolean
  nsfw?: boolean
  // thread inside this channel
  parent?: string
}

// fake discord.js message
const rawFor = (room: string, user: string, { guild = 'g1', manageGuild = false, manageChannels = false, nsfw = false, parent }: RawOptions = {}) => {
  const perms = (channelLevel: boolean) => ({ has: (flag: string) => flag === 'ManageGuild' ? manageGuild : flag === 'ManageChannels' ? channelLevel : false })
  const member = { permissions: perms(false) }
  const channel = parent
    ? { id: room, parentId: parent, parent: { id: parent, nsfw }, isThread: () => true, permissionsFor: () => perms(manageChannels) }
    : { id: room, nsfw, isThread: () => false, permissionsFor: () => perms(manageChannels) }
  return { guildId: guild, author: { id: user }, member: guild ? member : null, channel }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 10))

describe('Policy', () => {
  const state = setupRobot(['DisableBuiltinHelp.ts', 'Policy.ts', 'Garble.ts', 'Joke.ts', 'Puns.ts', 'Seen.ts'], { envVars: ['OWNER_USER_ID'] })
  let user: User

  beforeEach(() => {
    delete process.env.OWNER_USER_ID
    setRandomSource(() => 0)
    user = brainUser(state.robot, 'u1', 'alice')
  })

  const say = async (text: string, room = 'room', raw?: RawOptions) => {
    ;(user as unknown as { message?: unknown }).message = raw ? rawFor(room, 'u1', raw) : undefined
    await state.robot.adapter.say(user, text, room)
  }
  const bot = (text: string) => `@${state.robot.name} ${text}`

  describe('resolution', () => {
    it('starts new servers professional, with a hint for casual commands', async () => {
      inGuild(state.robot, 'g1', ['room'])
      const sent = collect(state.robot)
      await say(bot('garble hello there'))
      assert.deepStrictEqual(sent, ["That isn't enabled here. Someone who can manage this channel can turn it on with `Dumbotheelephant enable garble`."])
      // one hint a minute per channel
      await say(bot('garble again'))
      assert.strictEqual(sent.length, 1)
      // no hint for passive
      await say('functor')
      assert.strictEqual(sent.length, 1)
    })

    it('lets casual servers use casual and passive features', async () => {
      inGuild(state.robot, 'g1', ['room'], 'casual')
      const sent = collect(state.robot)
      await say(bot('garble hello'))
      await say('functor')
      assert.strictEqual(sent.length, 2)
      assert.ok(membersOf(state.robot, 'g:g1').u1?.seen)
    })

    it('stores no last-seen times where seen is off, but keeps names', async () => {
      inGuild(state.robot, 'g1', ['room'])
      await say('hello')
      assert.deepStrictEqual(membersOf(state.robot, 'g:g1').u1, { name: 'alice' })
    })

    it('lets a channel differ from its server', async () => {
      inGuild(state.robot, 'g1', ['room', 'quiet'], 'casual')
      policyFor(state.robot).update(d => {
        d.channels.quiet = { mode: 'professional', on: [], off: [] }
        d.channels.room = { on: [], off: ['garble'] }
      })
      const policy = policyFor(state.robot)
      assert.strictEqual(policy.allowsRoom('room', 'garble'), false)
      assert.strictEqual(policy.allowsRoom('room', 'puns'), true)
      assert.strictEqual(policy.allowsRoom('quiet', 'puns'), false)
      assert.strictEqual(policy.allowsRoom('quiet', 'joke'), true)
    })

    it('needs every parent feature on for a sub-feature', () => {
      inGuild(state.robot, 'g1', ['room'], 'casual')
      policyFor(state.robot).update(d => { d.channels.room = { on: ['joke.dark'], off: ['joke'] } })
      assert.strictEqual(policyFor(state.robot).allowsRoom('room', 'joke.dark'), false)
    })

    it('makes threads follow their parent channel', async () => {
      policyFor(state.robot).update(d => {
        d.guilds.g1 = { mode: 'casual', on: [], off: [] }
        d.channels.parent = { on: [], off: ['garble'] }
      })
      const sent = collect(state.robot)
      await say(bot('garble hello'), 'thread', { parent: 'parent' })
      assert.match(sent[0]!, /isn't enabled here/)
    })

    it('treats dms as casual, without passive features', async () => {
      const sent = collect(state.robot)
      await say(bot('garble hello'), 'dm', { guild: null })
      assert.strictEqual(sent.length, 1)
      assert.doesNotMatch(sent[0]!, /isn't enabled/)
      await say('hi there', 'dm', { guild: null })
      assert.strictEqual(state.robot.brain.get('dm:u1:members'), null)
    })

    it('keeps who was seen in one server out of other servers and dms', async () => {
      const { robot } = state
      policyFor(robot).update(d => {
        d.guilds.g1 = { mode: 'casual', on: [], off: [] }
        d.guilds.g2 = { mode: 'casual', on: [], off: [] }
      })
      const bob = brainUser(robot, 'u2', 'bob')
      ;(bob as unknown as { message?: unknown }).message = rawFor('room', 'u2')
      await robot.adapter.say(bob, 'hello', 'room')
      const sent = collect(robot)
      await say(bot('enable seen'), 'dm', { guild: null })
      await say(bot('who do you know'), 'dm', { guild: null })
      assert.strictEqual(sent.at(-1), 'I only keep track of people in servers.')
      await say(bot('seen bob'), 'dm', { guild: null })
      assert.strictEqual(sent.at(-1), 'I only keep track of people in servers.')
      await say(bot('who do you know'), 'other', { guild: 'g2' })
      assert.strictEqual(sent.at(-1), 'I know 1 person: alice')
      await say(bot('seen bob'), 'other', { guild: 'g2' })
      assert.strictEqual(sent.at(-1), "I haven't seen bob here.")
      await say(bot('seen bob'), 'room', {})
      assert.match(sent.at(-1)!, /^bob was last seen /)
    })

    it('treats rooms it cannot place as professional in production', () => {
      configurePolicy({ unknownMode: 'professional' })
      assert.strictEqual(policyFor(state.robot).allowsRoom('nowhere', 'garble'), false)
      assert.strictEqual(policyFor(state.robot).allowsRoom('nowhere', 'joke'), true)
    })

    it('never allows unregistered ids', () => {
      inGuild(state.robot, 'g1', ['room'], 'casual')
      assert.strictEqual(policyFor(state.robot).allowsRoom('room', 'nonsense.thing'), false)
    })
  })

  describe('settings', () => {
    it('needs Manage Server for the server and Manage Channels for a channel', async () => {
      const sent = collect(state.robot)
      await say(bot('mode casual'), 'room', {})
      assert.strictEqual(sent.at(-1), 'Only someone who can manage this server can do that.')
      await say(bot('mode casual'), 'room', { manageChannels: true })
      assert.strictEqual(sent.at(-1), 'Only someone who can manage this server can do that.')
      await say(bot('mode casual channel'), 'room', { manageChannels: true })
      assert.strictEqual(sent.at(-1), 'This channel is now casual.')
      await say(bot('mode casual'), 'room', { manageGuild: true })
      assert.strictEqual(sent.at(-1), 'This server is now casual.')
      assert.strictEqual(policyFor(state.robot).data().guilds.g1?.mode, 'casual')
    })

    it('turns features on and off, and says when the channel ends up different', async () => {
      const sent = collect(state.robot)
      await say(bot('enable garble'), 'room', { manageChannels: true })
      assert.strictEqual(sent.at(-1), 'Garble: on for this channel.')
      await say(bot('garble ab'), 'room', {})
      assert.strictEqual(sent.length, 2)
      await say(bot('disable garble server'), 'other', { manageGuild: true })
      assert.strictEqual(sent.at(-1), 'Garble: off for this server.')
      // a server-wide off beats the channel's on
      await say(bot('garble ab'), 'room', {})
      assert.strictEqual(sent.at(-1), "That isn't enabled here. Someone who can manage this server can turn it on with `Dumbotheelephant reset garble server`.")
      await say(bot('enable garble'), 'room', { manageChannels: true })
      assert.strictEqual(sent.at(-1), 'Garble is off for this whole server. Someone who can manage the server can undo that with `Dumbotheelephant reset garble server`.')
      await say(bot('enable garble server'), 'room', { manageGuild: true })
      await say(bot('disable garble'), 'room', { manageChannels: true })
      await say(bot('reset garble'), 'room', { manageChannels: true })
      assert.strictEqual(sent.at(-1), "Garble: back to the default for this channel. It's on here.")
    })

    it('keeps mature features to age-restricted channels', async () => {
      const sent = collect(state.robot)
      await say(bot('enable joke.dark'), 'room', { manageChannels: true })
      assert.match(sent.at(-1)!, /age-restricted channel/)
      await say(bot('enable joke.dark server'), 'room', { manageGuild: true, nsfw: true })
      assert.match(sent.at(-1)!, /age-restricted channel/)
      await say(bot('enable joke.dark'), 'nsfw', { manageChannels: true, nsfw: true })
      assert.strictEqual(sent.at(-1), 'Dark jokes: on for this channel.')
      // owner too
      process.env.OWNER_USER_ID = 'u1'
      await say(bot('enable joke.dark'), 'room', {})
      assert.match(sent.at(-1)!, /age-restricted channel/)
    })

    it('turns mature features off when a channel stops being age-restricted', () => {
      inGuild(state.robot, 'g1', ['nsfw'], 'casual', { nsfw: true })
      const policy = policyFor(state.robot)
      policy.update(d => { d.channels.nsfw = { on: ['joke.dark'], off: [] } })
      assert.strictEqual(policy.allowsRoom('nsfw', 'joke.dark'), true)
      inGuild(state.robot, 'g1', ['nsfw'])
      assert.strictEqual(policy.allowsRoom('nsfw', 'joke.dark'), false)
    })

    it("won't turn off locked features or touch unknown ones", async () => {
      const sent = collect(state.robot)
      await say(bot('disable help'), 'room', { manageGuild: true })
      assert.strictEqual(sent.at(-1), "Help can't be turned off.")
      await say(bot('enable directory'), 'room', { manageGuild: true })
      assert.match(sent.at(-1)!, /no feature called `directory`/)
    })

    it('lets anyone manage their own dms, and the owner anything', async () => {
      const sent = collect(state.robot)
      await say(bot('disable joke'), 'dm', { guild: null })
      assert.strictEqual(sent.at(-1), 'Jokes: off for our DMs.')
      process.env.OWNER_USER_ID = 'u1'
      await say(bot('mode casual'), 'room', {})
      assert.strictEqual(sent.at(-1), 'This server is now casual.')
    })

    it('shows settings, features and privacy', async () => {
      policyFor(state.robot).update(d => { d.guilds.g1 = { mode: 'casual', on: [], off: ['garble', 'gone.feature'] } })
      const sent = collect(state.robot)
      await say(bot('settings'), 'room', {})
      assert.match(sent.at(-1)!, /^\*\*Mode here\*\*: casual\n\*\*Server\*\*: mode casual; off: `garble`, `gone\.feature`\n\*\*Channel\*\*: no changes\n\*\*Off here\*\*: `garble`\n\*\*No longer exist\*\*: `gone\.feature`/)
      await say(bot('features'), 'room', {})
      assert.match(sent.at(-1)!, /\*\*Casual\*\*: .*⛔ garble/)
      assert.match(sent.at(-1)!, /✅ puns 👁/)
      assert.doesNotMatch(sent.at(-1)!, /Mature|joke\.dark/)
      await say(bot('features'), 'room', { nsfw: true })
      assert.match(sent.at(-1)!, /\*\*Mature\*\*: .*⛔ joke\.dark/)
      await say(bot('privacy'), 'room', {})
      assert.match(sent.at(-1)!, /👁 on \*\*Last seen\*\*: when each person last spoke/)
      assert.match(sent.at(-1)!, /kept for 60 days/)
    })

    it('applies presets with the right permission', async () => {
      const sent = collect(state.robot)
      await say(bot('presets'), 'room', {})
      assert.match(sent.at(-1)!, /`class`: professional, without streaks/)
      await say(bot('preset class'), 'room', { manageChannels: true })
      assert.strictEqual(sent.at(-1), 'Only someone who can manage this server can do that.')
      policyFor(state.robot).update(d => { d.guilds.g1 = { mode: 'casual', on: ['x'], off: [] } })
      await say(bot('preset class'), 'room', { manageGuild: true })
      assert.match(sent.at(-1)!, /^This server now uses the `class` preset/)
      assert.deepStrictEqual(policyFor(state.robot).data().guilds.g1, { mode: 'professional', on: [], off: ['streaks', 'history'], by: 'alice', at: policyFor(state.robot).data().guilds.g1!.at })
      await say(bot('preset nope'), 'room', { manageGuild: true })
      assert.match(sent.at(-1)!, /no preset called `nope`/)
    })

    it('filters help to what is on here', async () => {
      inGuild(state.robot, 'g1', ['room'])
      const sent = collect(state.robot)
      await say(bot('help'))
      assert.match(sent.at(-1)!, /\*\*Jokes\*\*: `joke`/)
      await say(bot('help joke'))
      assert.match(sent.at(-1)!, /^`Dumbotheelephant joke` – Replies/)
      assert.doesNotMatch(sent.at(-1)!, /garble|hubot/)
      await say(bot('help garble'))
      assert.strictEqual(sent.at(-1), 'Nothing here matches that.')
    })
  })

  describe('migration', () => {
    const ready = (robot: TestRobot, isReady: boolean) => {
      const adapter = robot.adapter as unknown as { client?: Record<string, unknown> }
      adapter.client = { isReady: () => isReady, guilds: { cache: new Map([['old1', {}], ['old2', {}]]) }, channels: { cache: new Map() } }
    }

    it('grandfathers current servers as casual and folds in the old toggles', async () => {
      const { robot } = state
      robot.brain.set('puns:disabled', { room1: { by: 'x', at: 1 } })
      robot.brain.set('lines:ai-off', { room2: { by: 'x', at: 1 } })
      ready(robot, true)
      robot.brain.emit('connected')
      await settle()
      const d = policyFor(robot).data()
      assert.ok(appliedMigrations(robot)['001-policy'])
      assert.strictEqual(d.guilds.old1?.mode, 'casual')
      assert.strictEqual(d.guilds.old2?.mode, 'casual')
      assert.deepStrictEqual(d.channels.room1?.off, ['puns'])
      assert.deepStrictEqual(d.channels.room2?.off, ['lines.ai'])
      assert.strictEqual(robot.brain.get('puns:disabled'), null)
      // later servers start professional
      policyFor(robot).update(dd => { dd.guilds.old1!.on.push('x') })
      robot.brain.emit('connected')
      await settle()
      assert.strictEqual(policyFor(robot).data().guilds.new, undefined)
      assert.deepStrictEqual(policyFor(robot).data().guilds.old1?.on, ['x'])
    })

    it('maps old toggles set in threads and dms', async () => {
      const { robot } = state
      robot.brain.set('puns:disabled', { thread1: { by: 'x', at: 1 }, dm1: { by: 'x', at: 1 } })
      ready(robot, true)
      const channels = (robot.adapter as unknown as { client: { channels: { cache: Map<string, unknown>, fetch: (id: string) => Promise<unknown> } } }).client.channels
      channels.cache.set('thread1', { id: 'thread1', guildId: 'old1', parentId: 'chan1', isThread: () => true })
      // dms aren't cached after a restart
      channels.fetch = async id => { channels.cache.set(id, { id, isDMBased: () => true, recipientId: 'u9' }) }
      robot.brain.emit('connected')
      await settle()
      const d = policyFor(robot).data()
      assert.deepStrictEqual(d.channels.chan1?.off, ['puns'])
      assert.deepStrictEqual(d.dms.u9?.off, ['puns'])
      assert.strictEqual(d.channels.thread1, undefined)
    })

    it('keeps a fresh brain professional', async () => {
      const { robot } = state
      delete robot.brain.data.users.u1
      ready(robot, true)
      robot.brain.emit('connected')
      await settle()
      assert.ok(appliedMigrations(robot)['001-policy'])
      assert.deepStrictEqual(policyFor(robot).data().guilds, {})
    })

    it('waits for discord to be ready', async () => {
      ready(state.robot, false)
      state.robot.brain.emit('connected')
      await settle()
      assert.strictEqual(state.robot.brain.get(POLICY_KEY), null)
    })
  })

  describe('gate', () => {
    it('stays closed when later middleware throws', async () => {
      inGuild(state.robot, 'g1', ['room'])
      state.robot.listenerMiddleware(async (_context) => { throw new Error('boom') })
      state.robot.on('error', () => {})
      const sent = collect(state.robot)
      await say(bot('garble hello'))
      assert.ok(sent.every(s => !s.includes('hello') || s.includes("isn't enabled")))
    })

    it('skips scheduled posts for features turned off since', async () => {
      inGuild(state.robot, 'g1', ['room'], 'casual')
      policyFor(state.robot).update(d => { d.channels.room = { on: [], off: ['garble'] } })
      const sent = collect(state.robot)
      await postToRoom(state.robot, 'room', 'garbled', 'garble')
      await postToRoom(state.robot, 'room', 'a joke', 'joke')
      assert.deepStrictEqual(sent, ['a joke'])
    })
  })
})
