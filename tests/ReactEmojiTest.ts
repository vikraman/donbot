import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { User } from 'hubot'

import { setupRobot, brainUser, collect } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'

import { setRandomSource } from '../scripts/lib/random.ts'
import { EMOJI_VOCAB } from '../scripts/lib/emojiVocab.ts'
import { BASIC_EMOJI } from '../contrib/basicEmoji.ts'
import { SENTIMENT_EMOJI, REACT_DELAY_MS, scoreMessage } from '../scripts/ReactEmoji.ts'

interface FakeMessage {
  reacted: string[]
  cache: Map<string, unknown>
  user: User
}

const POSITIVE = 'this is wonderful, amazing, so great, love it'
const NEGATIVE = 'ugh this is dreadful, awful and disappointing'
const NEUTRAL = 'just chatting about the plan for later'

const sentimentIn = (reacted: string[], mood: 'positive' | 'negative') =>
  reacted.filter(e => SENTIMENT_EMOJI[mood].includes(e))

// lets the async timer callback finish
const flush = () => new Promise(resolve => setImmediate(resolve))

describe('ReactEmoji scoring', () => {
  it('scores exact rare names', () => {
    assert.strictEqual(scoreMessage('saw an octopus today'), '🐙')
  })
  it('scores related vocabulary and plurals', () => {
    assert.strictEqual(scoreMessage('that tentacle was huge'), '🐙')
    assert.strictEqual(scoreMessage('the lava was still glowing'), '🌋')
    assert.strictEqual(scoreMessage('who wants tacos'), '🌮')
  })
  it('ignores common words and plain emotion', () => {
    for (const text of ['had breakfast', 'love this, great work team, amazing!', 'my dog is here', 'see you at the meeting']) {
      assert.strictEqual(scoreMessage(text), null, text)
    }
  })
  it('accepts two mid-frequency words for the same emoji', () => {
    const [word, emojis] = Object.entries(EMOJI_VOCAB.related)
      .find(([w, es]) => es.length === 1 && /^[a-z]+$/.test(w) && scoreMessage(w) === null &&
        Object.entries(EMOJI_VOCAB.related).some(([o, os]) => o !== w && os.length === 1 && os[0] === es[0] && scoreMessage(o) === null))!
    const other = Object.entries(EMOJI_VOCAB.related).find(([o, os]) => o !== word && os.length === 1 && os[0] === emojis[0] && scoreMessage(o) === null)![0]
    assert.strictEqual(scoreMessage(`${word} and ${other}`), emojis[0])
  })
  it('prefers the highest-scoring emoji', () => {
    setRandomSource(() => 0)
    assert.strictEqual(scoreMessage('an octopus with tentacles near some lava'), '🐙')
    setRandomSource(null)
  })
})

describe('ReactEmoji emoji data', () => {
  it('keeps sentiment pools free of basic emojis', () => {
    for (const emoji of [...SENTIMENT_EMOJI.positive, ...SENTIMENT_EMOJI.negative]) {
      assert.ok(!BASIC_EMOJI.has(emoji), emoji)
    }
  })
  it('maps words to non-empty emoji lists, never basic', () => {
    for (const [word, emojis] of Object.entries(EMOJI_VOCAB.related)) {
      assert.ok(Array.isArray(emojis) && emojis.length > 0, word)
      for (const emoji of emojis) assert.ok(!BASIC_EMOJI.has(emoji), `${word} -> ${emoji}`)
    }
    for (const [word, emoji] of Object.entries(EMOJI_VOCAB.names)) {
      assert.ok(!BASIC_EMOJI.has(emoji), `${word} -> ${emoji}`)
    }
  })
})

describe('ReactEmoji testing Hubot scripts', () => {
  const state = setupRobot('ReactEmoji.ts')
  let now: number

  beforeEach(() => {
    now = 1_000_000_000_000
    mock.method(Date, 'now', () => now)
    mock.timers.enable({ apis: ['setTimeout'] })
    setRandomSource(() => 0)
  })

  const fakeUser = (robot: TestRobot, id = 'test-user', name = 'test user'): FakeMessage => {
    const fake = { reacted: [] as string[], cache: new Map<string, unknown>() } as FakeMessage
    fake.user = brainUser(robot, id, name, {
      message: { react: async (emoji: string) => { fake.reacted.push(emoji) }, reactions: { cache: fake.cache } }
    })
    return fake
  }

  const say = async (robot: TestRobot, fake: FakeMessage, text: string, room = 'test-room') => {
    await robot.adapter.say(fake.user, text, room)
  }

  const settle = async () => {
    mock.timers.tick(REACT_DELAY_MS)
    await flush()
  }

  it('reacts with one vocabulary emoji, only after the delay', async () => {
    const fake = fakeUser(state.robot)
    await say(state.robot, fake, 'saw an octopus today')
    assert.deepStrictEqual(fake.reacted, [])
    await settle()
    assert.deepStrictEqual(fake.reacted, ['🐙'])
  })
  it('does not react to common words', async () => {
    const fake = fakeUser(state.robot)
    await say(state.robot, fake, 'want cheese and toast for breakfast')
    await say(state.robot, fake, 'great work team')
    await settle()
    assert.deepStrictEqual(fake.reacted, [])
  })
  it('does not react to upbeat text without enough room history', async () => {
    const fake = fakeUser(state.robot)
    await say(state.robot, fake, 'love this, great work team, amazing!')
    await settle()
    assert.deepStrictEqual(fake.reacted, [])
  })
  it('skips messages someone already reacted to', async () => {
    const fake = fakeUser(state.robot)
    await say(state.robot, fake, 'saw an octopus today')
    fake.cache.set('👀', {})
    await settle()
    assert.deepStrictEqual(fake.reacted, [])
  })
  it('skips messages addressed to the bot', async () => {
    const fake = fakeUser(state.robot)
    await say(state.robot, fake, `${state.robot.name} tell me about the octopus`)
    await settle()
    assert.deepStrictEqual(fake.reacted, [])
  })
  it('does not throw without a react method or when react rejects', async () => {
    const plain = brainUser(state.robot, 'plain', 'plain')
    await assert.doesNotReject(state.robot.adapter.say(plain, 'saw an octopus today', 'test-room'))
    const failing = brainUser(state.robot, 'failing', 'failing', {
      message: { react: async () => { throw new Error('unknown message') }, reactions: { cache: new Map() } }
    })
    await state.robot.adapter.say(failing, 'saw an octopus today', 'test-room')
    await assert.doesNotReject(settle())
  })

  describe('conversation tone', () => {
    it('reacts once when the room turns positive, not on every upbeat message', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 4; i++) await say(state.robot, fake, POSITIVE)
      await settle()
      assert.deepStrictEqual(fake.reacted, [])
      await say(state.robot, fake, POSITIVE)
      await settle()
      assert.strictEqual(sentimentIn(fake.reacted, 'positive').length, 1)
      for (let i = 0; i < 5; i++) await say(state.robot, fake, POSITIVE)
      await settle()
      assert.strictEqual(fake.reacted.length, 1)
    })
    it('reacts again after the room settles back to neutral', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 5; i++) await say(state.robot, fake, POSITIVE)
      for (let i = 0; i < 20; i++) await say(state.robot, fake, NEUTRAL)
      for (let i = 0; i < 5; i++) await say(state.robot, fake, POSITIVE)
      await settle()
      assert.strictEqual(sentimentIn(fake.reacted, 'positive').length, 2)
    })
    it('reacts once when the room turns negative', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 6; i++) await say(state.robot, fake, NEGATIVE)
      await settle()
      assert.strictEqual(sentimentIn(fake.reacted, 'negative').length, 1)
      assert.strictEqual(fake.reacted.length, 1)
    })
    it('ignores a single negative outlier in a positive room', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 6; i++) await say(state.robot, fake, POSITIVE)
      await say(state.robot, fake, NEGATIVE)
      await settle()
      assert.deepStrictEqual(sentimentIn(fake.reacted, 'negative'), [])
    })
    it('forgets messages older than the window', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 4; i++) await say(state.robot, fake, POSITIVE)
      now += 31 * 60 * 1000
      await say(state.robot, fake, POSITIVE)
      await settle()
      assert.deepStrictEqual(fake.reacted, [])
      const stored = state.robot.brain.get<{ entries: unknown[] }>('reactemoji:tone:test-room')!
      assert.strictEqual(stored.entries.length, 1)
    })
    it('caps the window and stores numbers only', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 25; i++) await say(state.robot, fake, `${NEUTRAL} ${i}`)
      const stored = state.robot.brain.get<{ mood: string, entries: Record<string, unknown>[] }>('reactemoji:tone:test-room')!
      assert.strictEqual(stored.entries.length, 20)
      for (const entry of stored.entries) {
        assert.deepStrictEqual(Object.keys(entry).sort(), ['comparative', 'ts'])
        assert.strictEqual(typeof entry.comparative, 'number')
      }
    })
    it('adds at most one vocabulary and one sentiment emoji', async () => {
      const fake = fakeUser(state.robot)
      for (let i = 0; i < 4; i++) await say(state.robot, fake, POSITIVE)
      await say(state.robot, fake, `${POSITIVE}, look at that octopus`)
      await settle()
      assert.strictEqual(fake.reacted.length, 2)
      assert.strictEqual(fake.reacted[0], '🐙')
      assert.strictEqual(sentimentIn(fake.reacted, 'positive').length, 1)
    })
  })

  describe('channel toggle', () => {
    it('turns reactions off and on per channel', async () => {
      const replies = collect(state.robot)
      const fake = fakeUser(state.robot, 'toggler', 'toggler')
      await say(state.robot, fake, `${state.robot.name} reactions off`)
      assert.match(replies.at(-1)!, /off in this channel/)
      await say(state.robot, fake, 'saw an octopus today')
      await say(state.robot, fake, 'saw an octopus today', 'other-room')
      await settle()
      assert.deepStrictEqual(fake.reacted, ['🐙'])

      await say(state.robot, fake, `${state.robot.name} reactions on`)
      assert.match(replies.at(-1)!, /on in this channel/)
      await say(state.robot, fake, 'saw an octopus today')
      await settle()
      assert.deepStrictEqual(fake.reacted, ['🐙', '🐙'])
    })
    it('drops a pending reaction when the channel is turned off during the delay', async () => {
      const fake = fakeUser(state.robot)
      await say(state.robot, fake, 'saw an octopus today')
      await say(state.robot, fake, `${state.robot.name} reactions off`)
      await settle()
      assert.deepStrictEqual(fake.reacted, [])
    })
    it('reports status with who turned it off', async () => {
      const replies = collect(state.robot)
      const fake = fakeUser(state.robot, 'toggler', 'toggler')
      await say(state.robot, fake, `${state.robot.name} reactions`)
      assert.match(replies.at(-1)!, /are on/)
      await say(state.robot, fake, `${state.robot.name} reactions off`)
      await say(state.robot, fake, `${state.robot.name} reactions status`)
      assert.match(replies.at(-1)!, /are off .*toggler/)
    })
  })

  it('removes legacy tone history on brain load', async () => {
    state.robot.brain.set('reactemoji:history:old-room', [{ comparative: 1, ts: 1 }])
    state.robot.brain.emit('loaded', state.robot.brain.data)
    assert.strictEqual(state.robot.brain.get('reactemoji:history:old-room'), null)
  })
})
