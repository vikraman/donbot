import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { clock } from './helpers/fakes.ts'

import { VOTE_COOLDOWN_MS, MAX_THINGS, MAX_VOTES_PER_WINDOW, VOTE_WINDOW_MS } from '../scripts/Kudos.ts'
import { eventsSince } from '../scripts/lib/eventLog.ts'
import { configureLines } from '../scripts/lib/lines.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

// rolls high: no leaderboard commentary, first pick
const quiet = () => setRandomSource(c => Math.floor(0.9 * c))

describe('Kudos', () => {
  const state = setupRobot('Kudos.ts')

  // chat plus alice (id 123) and bob
  const people = () => {
    const c = chat(state)
    const alice = brainUser(c.robot, '123', 'alice')
    const bob = brainUser(c.robot, 'bob-id', 'bob')
    return { ...c, alice, bob }
  }

  describe('points for things', () => {
    it('counts ++ and -- across users, with reasons', async () => {
      const { say, sent, bob } = people()
      await say('donbot++')
      await say('donbot++', { user: bob })
      await say('mondays--')
      await say('coffee++ for getting me through monday')
      assert.deepStrictEqual(sent, ['donbot: 1', 'donbot: 2', 'mondays: -1', 'coffee: 1 (for getting me through monday)'])
    })

    it('ignores code and sentences that only look like votes', async () => {
      const { say, sent } = chat(state)
      for (const text of ['c++', 'g++ for linking', 'i--', 'I love c++', 'ok --', 'that was 2--', 'this whole week was a disaster--', `${'x'.repeat(41)}++`]) {
        await say(text)
      }
      assert.deepStrictEqual(sent, [])
      await say('release train++')
      assert.strictEqual(sent[0], 'release train: 1')
    })

    it('forgets a thing back at zero unless it has reasons', async () => {
      const { say, alice, bob, robot } = people()
      await say('pizza++', { user: alice })
      await say('pizza--', { user: bob })
      assert.strictEqual(robot.brain.get('plusplus:pizza'), null)
      await say('tea++ for warmth', { user: alice })
      await say('tea--', { user: bob })
      assert.strictEqual(robot.brain.get('plusplus:tea'), 0)
    })

    it('stops tracking new things past the cap', async () => {
      const { robot, say, sent } = chat(state)
      for (let i = 0; i < MAX_THINGS; i++) robot.brain.set(`plusplus:thing${i}`, 1)
      robot.brain.set('plusplus:user:9', 1)
      await say('newthing++')
      await say('thing3++')
      assert.deepStrictEqual(sent, ['thing3: 2'])
      assert.strictEqual(robot.brain.get('plusplus:newthing'), null)
    })

    it('reports a score via "score for" and "points for"', async () => {
      const { say, ask, sent } = chat(state)
      await say('donbot++')
      await ask('score for donbot')
      await ask('points for donbot')
      assert.deepStrictEqual(sent, ['donbot: 1', 'donbot: 1', 'donbot: 1'])
    })

    it('lists the latest reasons for a thing', async () => {
      const { say, ask, sent, bob } = people()
      const alice = brainUser(state.robot, 'alice-id', 'ann')
      await ask('reasons for tea')
      assert.strictEqual(sent[0], 'No reasons recorded for tea yet.')
      await say('tea++ for warmth', { user: alice })
      await say('tea-- for being too hot', { user: bob })
      await say('tea++', { user: bob, room: 'other-room' })
      await ask('reasons for tea', { user: alice })
      assert.strictEqual(sent.at(-1), 'Why tea has points:\n• (−) being too hot — from <@bob-id>, just now\n• warmth — from <@alice-id>, just now')
    })
  })

  describe('points for people', () => {
    it('keys a mention by user id and renders the mention', async () => {
      const { robot, say, ask, sent } = people()
      await say('<@123>++ for the review')
      await ask('score for alice')
      assert.deepStrictEqual(sent, ['<@123>: 1 (for the review)', '<@123>: 1'])
      assert.strictEqual(robot.brain.get('plusplus:user:123'), 1)
    })

    it('takes a space before ++ for people', async () => {
      const { say, sent } = people()
      await say('<@123> ++')
      await say('@bob ++ for reviewing')
      assert.deepStrictEqual(sent, ['<@123>: 1', '<@bob-id>: 1 (for reviewing)'])
    })

    it('resolves @name and exact names, and ignores unknown names', async () => {
      const { say, sent, bob } = people()
      await say('@nobody++')
      await say('@alice++')
      await say('Alice++', { user: bob })
      assert.deepStrictEqual(sent, ['<@123>: 1', '<@123>: 2'])
    })

    it('refuses self ++ with a joke and no points', async () => {
      quiet()
      const { robot, say, sent, alice } = people()
      await say('<@123>++', { user: alice })
      assert.strictEqual(sent.length, 1)
      assert.doesNotMatch(sent[0]!, /: \d/)
      assert.strictEqual(robot.brain.get('plusplus:user:123') ?? null, null)
    })
  })

  describe('kudos command', () => {
    it('acks kudos with or without a reason, celebrating milestones', async () => {
      const { robot, ask, sent } = people()
      brainUser(robot, '456', 'carol smith')
      brainUser(robot, '789', 'dave')
      robot.brain.set('plusplus:user:789', 9)
      await ask('kudos <@123> for fixing the deploy')
      await ask('kudos carol smith')
      await ask('kudos <@789> for the release')
      assert.match(sent[0]!, /^(?=.*<@123>)(?=.*fixing the deploy).* \(score: 1\)$/)
      assert.match(sent[1]!, /<@456>.* \(score: 1\)$/)
      const [ack, milestone, ...rest] = sent[2]!.split('\n')
      assert.match(ack!, /^(?=.*<@789>)(?=.*the release).* \(score: 10\)$/)
      assert.match(milestone!, /^🎊 (?=.*<@789>)(?=.*10)/)
      assert.deepStrictEqual(rest, [])
    })

    it('refuses unknown people and yourself', async () => {
      quiet()
      const { ask, sent, alice } = people()
      await ask('kudos coffee for existing')
      await ask('kudos <@123> for being me', { user: alice })
      assert.strictEqual(sent[0], "I don't know who coffee is. Try mentioning them.")
      assert.strictEqual(sent.length, 2)
      assert.doesNotMatch(sent[1]!, /score/)
    })

    it('says so when kudos hit the cooldown', async () => {
      const { say, ask, sent } = people()
      await say('<@123>++')
      await ask('kudos <@123> for more')
      assert.strictEqual(sent[1], 'You just gave <@123> a point. Give it a few minutes.')
    })

    it('lists kudos reasons for a person, newest first', async () => {
      const { robot, ask, sent } = chat(state)
      const alice = brainUser(robot, 'alice-id', 'alice')
      const carol = brainUser(robot, 'carol-id', 'carol')
      brainUser(robot, '123', 'bob')
      const t = clock(1_000_000_000)
      await ask('kudos bob for the docs', { user: alice })
      t.advance(2 * 3_600_000)
      await ask('kudos <@123> for pairing', { user: carol })
      await ask('kudos for bob', { user: alice })
      assert.strictEqual(sent.at(-1), 'Why <@123> has points:\n• pairing — from <@carol-id>, just now\n• the docs — from <@alice-id>, 2h ago')
    })

    it('logs every vote to the kudos event log', async () => {
      const { robot, say, ask } = people()
      await ask('kudos <@123> for shipping')
      await say('mondays--')
      const log = eventsSince(robot, 'kudos', 0).map(({ ts: _ts, ...rest }) => rest)
      assert.deepStrictEqual(log, [
        { room: 'test-room', userId: 'test-user', target: '<@123>', targetId: '123', reason: 'shipping', delta: 1 },
        { room: 'test-room', userId: 'test-user', target: 'mondays', targetId: undefined, reason: undefined, delta: -1 }
      ])
    })
  })

  describe('limits', () => {
    it('ignores repeat votes from the same user within the cooldown', async () => {
      const { say, ask, sent } = chat(state)
      for (let i = 0; i < 5; i++) await say('donbot++')
      await say('DONBOT--', { room: 'other-room' })
      await ask('score for donbot')
      assert.deepStrictEqual(sent, ['donbot: 1', 'donbot: 1'])
    })

    it('lets the same user vote again once the cooldown expires', async () => {
      const t = clock(1_000_000)
      const { say, sent } = chat(state)
      await say('donbot++')
      t.advance(VOTE_COOLDOWN_MS)
      await say('donbot++')
      assert.strictEqual(sent[1], 'donbot: 2')
    })

    it('ignores a user flooding votes, without blocking others', async () => {
      const { say, sent, bob } = people()
      for (let i = 0; i < MAX_VOTES_PER_WINDOW + 3; i++) await say(`thing${i}++`)
      assert.strictEqual(sent.length, MAX_VOTES_PER_WINDOW)
      await say('donbot++', { user: bob })
      assert.strictEqual(sent.at(-1), 'donbot: 1')
    })

    it('keeps the per-thing cooldown for a vote dropped by the flood limit', async () => {
      const t = clock(1_000_000)
      const { say, sent } = chat(state)
      for (let i = 0; i < MAX_VOTES_PER_WINDOW; i++) await say(`thing${i}++`)
      await say('donbot++')
      t.advance(VOTE_WINDOW_MS)
      await say('donbot++')
      assert.strictEqual(sent.at(-1), 'donbot: 1')
    })
  })

  describe('leaderboard', () => {
    it('says when there are no scores', async () => {
      const { ask, sent } = chat(state)
      await ask('leaderboard')
      await ask('leaderboard week')
      assert.deepStrictEqual(sent, ['No scores yet.', 'No points changed hands this week.'])
    })

    it('lists things and people in descending order', async () => {
      quiet()
      const { robot, ask, sent } = chat(state)
      robot.brain.set('plusplus:tacos', 5)
      robot.brain.set('plusplus:pizza', 10)
      robot.brain.set('plusplus:user:123', 7)
      robot.brain.set('kudos:reasons:tacos', [{ reason: 'yum', by: 'x', ts: 1, delta: 1 }])
      await ask('leaderboard')
      await ask('leaderboard people')
      await ask('top scores things')
      assert.deepStrictEqual(sent, ['1. pizza: 10\n2. <@123>: 7\n3. tacos: 5', '1. <@123>: 7', '1. pizza: 10\n2. tacos: 5'])
    })

    it('adds top-scorer commentary on a lucky roll, plain in professional rooms', async () => {
      setRandomSource(() => 0)
      const { robot, ask, sent } = chat(state)
      robot.brain.set('plusplus:tacos', 5)
      robot.brain.set('plusplus:pizza', 10)
      await ask('leaderboard')
      assert.match(sent[0]!, /pizza is untouchable right now\./)
      configureLines({ casual: () => false })
      await ask('leaderboard')
      assert.match(sent[1]!, /pizza leads the board\./)
    })

    it('ranks net gains over the last week', async () => {
      quiet()
      const t = clock(1_000_000_000_000)
      const { robot, say, ask, sent } = chat(state)
      const alice = brainUser(robot, 'alice-id', 'alice')
      const bob = brainUser(robot, 'bob-id', 'bob')
      brainUser(robot, '123', 'carol')
      await say('pizza++', { user: alice })
      t.advance(8 * 86_400_000)
      await say('<@123>++', { user: alice })
      await say('<@123>++', { user: bob })
      await say('mondays--', { user: alice })
      await ask('leaderboard week', { user: alice })
      assert.strictEqual(sent.at(-1), 'This week:\n1. <@123>: 2\n2. mondays: -1')
    })
  })
})
