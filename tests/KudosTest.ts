import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { VOTE_COOLDOWN_MS, MAX_VOTES_PER_WINDOW, VOTE_WINDOW_MS } from '../scripts/Kudos.ts'
import { eventsSince } from '../scripts/lib/eventLog.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

// rolls high: no leaderboard commentary, first pick
const quiet = () => setRandomSource(c => Math.floor(0.9 * c))

describe('Kudos testing Hubot scripts', () => {
  const state = setupRobot('Kudos.ts')

  describe('points for things', () => {
    it('should increment a score on ++', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, 'donbot++', 'test-room')
      assert.strictEqual(sent[0], 'donbot: 1')
    })
    it('should decrement a score on --', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, 'donbot--', 'test-room')
      assert.strictEqual(sent[0], 'donbot: -1')
    })
    it('should accept and echo a reason', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, 'coffee++ for getting me through monday', 'test-room')
      assert.strictEqual(sent[0], 'coffee: 1 (for getting me through monday)')
    })
    it('should accumulate score across multiple users', async () => {
      const { robot } = state
      const alice = brainUser(robot, 'alice-id', 'alice')
      const bob = brainUser(robot, 'bob-id', 'bob')
      const sent = collect(robot)
      await robot.adapter.say(alice, 'donbot++', 'test-room')
      await robot.adapter.say(bob, 'donbot++', 'test-room')
      assert.strictEqual(sent[1], 'donbot: 2')
    })
    it('should report score via "score for" and "points for"', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, 'donbot++', 'test-room')
      await robot.adapter.say(user, '@Dumbotheelephant score for donbot', 'test-room')
      await robot.adapter.say(user, '@Dumbotheelephant points for donbot', 'test-room')
      assert.deepStrictEqual(sent, ['donbot: 1', 'donbot: 1', 'donbot: 1'])
    })
    it('should list the latest reasons for a thing', async () => {
      const { robot } = state
      const alice = brainUser(robot, 'alice-id', 'alice')
      const bob = brainUser(robot, 'bob-id', 'bob')
      const sent = collect(robot)
      await robot.adapter.say(alice, 'tea++ for warmth', 'test-room')
      await robot.adapter.say(bob, 'tea-- for being too hot', 'test-room')
      await robot.adapter.say(bob, 'tea++', 'other-room')
      await robot.adapter.say(alice, '@Dumbotheelephant reasons for tea', 'test-room')
      assert.strictEqual(sent.at(-1), 'Why tea has points:\n• (−) being too hot — from <@bob-id>, just now\n• warmth — from <@alice-id>, just now')
    })
    it('should say when a thing has no reasons', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant reasons for tea', 'test-room')
      assert.strictEqual(sent[0], 'No reasons recorded for tea yet.')
    })
  })

  describe('points for people', () => {
    it('should key a mention by user id and render the mention', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice')
      const sent = collect(robot)
      await robot.adapter.say(user, '<@123>++ for the review', 'test-room')
      await robot.adapter.say(user, '@Dumbotheelephant score for alice', 'test-room')
      assert.deepStrictEqual(sent, ['<@123>: 1 (for the review)', '<@123>: 1'])
      assert.strictEqual(robot.brain.get('plusplus:user:123'), 1)
    })
    it('should resolve @name and exact names to people', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice')
      const bob = brainUser(robot, 'bob-id', 'bob')
      const sent = collect(robot)
      await robot.adapter.say(user, '@alice++', 'test-room')
      await robot.adapter.say(bob, 'Alice++', 'test-room')
      assert.deepStrictEqual(sent, ['<@123>: 1', '<@123>: 2'])
    })
    it('should ignore ++ for an unknown @name', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@nobody++', 'test-room')
      assert.deepStrictEqual(sent, [])
    })
    it('should refuse self ++ with a joke and no points', async () => {
      const { robot } = state
      quiet()
      const user = brainUser(robot, '123', 'alice')
      const sent = collect(robot)
      await robot.adapter.say(user, '<@123>++', 'test-room')
      assert.strictEqual(sent.length, 1)
      assert.doesNotMatch(sent[0]!, /: \d/)
      assert.strictEqual(robot.brain.get('plusplus:user:123') ?? null, null)
    })
  })

  describe('kudos command', () => {
    it('should give kudos with a reason and a warm ack', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant kudos <@123> for fixing the deploy', 'test-room')
      assert.strictEqual(sent[0], '🎉 Kudos to <@123> for fixing the deploy! (score: 1)')
    })
    it('should give kudos by name without a reason', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice smith')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant kudos alice smith', 'test-room')
      assert.strictEqual(sent[0], '🎉 Kudos to <@123>! (score: 1)')
    })
    it('should celebrate round-number scores', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice')
      robot.brain.set('plusplus:user:123', 9)
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant kudos <@123> for the release', 'test-room')
      assert.strictEqual(sent[0], '🎉 Kudos to <@123> for the release! (score: 10)\n🎊 That makes 10 points for <@123>. A milestone!')
    })
    it('should not repeat an ack back to back', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const people = Array.from({ length: 30 }, (_, i) => brainUser(robot, `${9000 + i}`, `person ${i}`))
      const sent = collect(robot)
      // fresh ids dodge the per-target cooldown; a new voter per 5 dodges the burst limit
      for (const [i, p] of people.entries()) {
        const voter = brainUser(robot, `v${Math.floor(i / 5)}`, `voter ${Math.floor(i / 5)}`)
        await robot.adapter.say(voter, `@Dumbotheelephant kudos <@${p.id}>`, 'test-room')
      }
      const acks = sent.map(s => s.replace(/<@9\d+>/g, '@x').replace(/ \(score: \d+\)$/, ''))
      assert.equal(acks.length, 30)
      acks.forEach((ack, i) => { if (i) assert.notEqual(ack, acks[i - 1]) })
      assert.ok(user)
    })
    it('should not give kudos to an unknown person', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant kudos coffee for existing', 'test-room')
      assert.strictEqual(sent[0], "I don't know who coffee is. Try mentioning them.")
    })
    it('should not give yourself kudos', async () => {
      const { robot } = state
      quiet()
      const user = brainUser(robot, '123', 'alice')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant kudos <@123> for being me', 'test-room')
      assert.strictEqual(sent.length, 1)
      assert.doesNotMatch(sent[0]!, /score/)
    })
    it('should say so when kudos hit the cooldown', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice')
      const sent = collect(robot)
      await robot.adapter.say(user, '<@123>++', 'test-room')
      await robot.adapter.say(user, '@Dumbotheelephant kudos <@123> for more', 'test-room')
      assert.strictEqual(sent[1], 'You just gave <@123> a point. Give it a few minutes.')
    })
    it('should list kudos reasons for a person, newest first', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      const alice = brainUser(robot, 'alice-id', 'alice')
      const carol = brainUser(robot, 'carol-id', 'carol')
      brainUser(robot, '123', 'bob')
      const sent = collect(robot)
      const now = mock.method(Date, 'now', () => 1_000_000_000)
      await robot.adapter.say(alice, '@Dumbotheelephant kudos bob for the docs', 'test-room')
      now.mock.mockImplementation(() => 1_000_000_000 + 2 * 3_600_000)
      await robot.adapter.say(carol, '@Dumbotheelephant kudos <@123> for pairing', 'test-room')
      await robot.adapter.say(alice, '@Dumbotheelephant kudos for bob', 'test-room')
      assert.strictEqual(sent.at(-1), 'Why <@123> has points:\n• pairing — from <@carol-id>, just now\n• the docs — from <@alice-id>, 2h ago')
    })
    it('should log every vote to the kudos event log', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      const user = brainUser(robot, 'test-user', 'test user')
      brainUser(robot, '123', 'alice')
      await robot.adapter.say(user, '@Dumbotheelephant kudos <@123> for shipping', 'test-room')
      await robot.adapter.say(user, 'mondays--', 'test-room')
      const log = eventsSince(robot, 'kudos', 0).map(({ ts, ...rest }) => rest)
      assert.deepStrictEqual(log, [
        { room: 'test-room', userId: 'test-user', target: '<@123>', targetId: '123', reason: 'shipping', delta: 1 },
        { room: 'test-room', userId: 'test-user', target: 'mondays', targetId: undefined, reason: undefined, delta: -1 }
      ])
    })
  })

  describe('limits', () => {
    it('should ignore repeat votes from the same user within the cooldown', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      for (let i = 0; i < 5; i++) await robot.adapter.say(user, 'donbot++', 'test-room')
      await robot.adapter.say(user, 'DONBOT--', 'other-room')
      await robot.adapter.say(user, '@Dumbotheelephant score for donbot', 'test-room')
      assert.deepStrictEqual(sent, ['donbot: 1', 'donbot: 1'])
    })
    it('should let the same user vote again once the cooldown expires', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      const now = mock.method(Date, 'now', () => 1_000_000)
      await robot.adapter.say(user, 'donbot++', 'test-room')
      now.mock.mockImplementation(() => 1_000_000 + VOTE_COOLDOWN_MS)
      await robot.adapter.say(user, 'donbot++', 'test-room')
      assert.strictEqual(sent[1], 'donbot: 2')
    })
    it('should ignore a user flooding votes across many things', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      for (let i = 0; i < MAX_VOTES_PER_WINDOW + 3; i++) await robot.adapter.say(user, `thing${i}++`, 'test-room')
      assert.strictEqual(sent.length, MAX_VOTES_PER_WINDOW)
    })
    it('should not use up the per-thing cooldown on a vote dropped by the flood limit', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      const now = mock.method(Date, 'now', () => 1_000_000)
      for (let i = 0; i < MAX_VOTES_PER_WINDOW; i++) await robot.adapter.say(user, `thing${i}++`, 'test-room')
      await robot.adapter.say(user, 'donbot++', 'test-room')
      now.mock.mockImplementation(() => 1_000_000 + VOTE_WINDOW_MS)
      await robot.adapter.say(user, 'donbot++', 'test-room')
      assert.strictEqual(sent.at(-1), 'donbot: 1')
    })
    it("should not let one user's flood block another user", async () => {
      const { robot } = state
      const alice = brainUser(robot, 'alice-id', 'alice')
      const bob = brainUser(robot, 'bob-id', 'bob')
      const sent = collect(robot)
      for (let i = 0; i < MAX_VOTES_PER_WINDOW + 1; i++) await robot.adapter.say(alice, `thing${i}++`, 'test-room')
      await robot.adapter.say(bob, 'donbot++', 'test-room')
      assert.strictEqual(sent.at(-1), 'donbot: 1')
    })
  })

  describe('leaderboard', () => {
    it('should say there are no scores yet', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
      assert.strictEqual(sent[0], 'No scores yet.')
    })
    it('should list things and people in descending order', async () => {
      const { robot } = state
      quiet()
      robot.brain.set('plusplus:tacos', 5)
      robot.brain.set('plusplus:pizza', 10)
      robot.brain.set('plusplus:user:123', 7)
      robot.brain.set('kudos:reasons:tacos', [{ reason: 'yum', by: 'x', ts: 1, delta: 1 }])
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
      await robot.adapter.say(user, '@Dumbotheelephant leaderboard people', 'test-room')
      await robot.adapter.say(user, '@Dumbotheelephant top scores things', 'test-room')
      assert.deepStrictEqual(sent, ['1. pizza: 10\n2. <@123>: 7\n3. tacos: 5', '1. <@123>: 7', '1. pizza: 10\n2. tacos: 5'])
    })
    it('should include commentary about the top scorer when the roll succeeds', async () => {
      const { robot } = state
      setRandomSource(() => 0)
      robot.brain.set('plusplus:tacos', 5)
      robot.brain.set('plusplus:pizza', 10)
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant leaderboard', 'test-room')
      assert.match(sent[0]!, /pizza is untouchable right now\./)
    })
    it('should rank net gains over the last week', async () => {
      const { robot } = state
      quiet()
      const alice = brainUser(robot, 'alice-id', 'alice')
      const bob = brainUser(robot, 'bob-id', 'bob')
      brainUser(robot, '123', 'carol')
      const now = mock.method(Date, 'now', () => 1_000_000_000_000)
      await robot.adapter.say(alice, 'pizza++', 'test-room')
      now.mock.mockImplementation(() => 1_000_000_000_000 + 8 * 86_400_000)
      await robot.adapter.say(alice, '<@123>++', 'test-room')
      await robot.adapter.say(bob, '<@123>++', 'test-room')
      await robot.adapter.say(alice, 'mondays--', 'test-room')
      const sent = collect(robot)
      await robot.adapter.say(alice, '@Dumbotheelephant leaderboard week', 'test-room')
      assert.strictEqual(sent[0], 'This week:\n1. <@123>: 2\n2. mondays: -1')
    })
    it('should say when nothing changed this week', async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = collect(robot)
      await robot.adapter.say(user, '@Dumbotheelephant leaderboard week', 'test-room')
      assert.strictEqual(sent[0], 'No points changed hands this week.')
    })
  })
})
