import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'

import { setupRobot, chat, inGuild, sendReturnsIds } from './helpers/setup.ts'
import { clock, fakeClient } from './helpers/fakes.ts'

import { setRandomSource } from '../scripts/lib/random.ts'
import { JARGON } from '../scripts/lib/punJargon.ts'
import {
  findPuns, feedbackFor, chanceFor, PUN_CHANCE, MIN_CHANCE, MAX_CHANCE, PUN_COOLDOWN_MS, REPEAT_WINDOW_MS, FEEDBACK_HALF_LIFE_MS
} from '../scripts/Puns.ts'

// kind:word for each pun found
const found = (text: string) => findPuns(text, 'donbot').map(p => `${p.kind}:${p.word}`)

describe('Puns detection', () => {
  for (const [text, expected] of [
    ['the functor is lovely', ['her:functor']],
    ['two functors', ['her:functor']],
    ['the printer and the manager are faster and better', []],
    ['proved the theorem', ['em:theorem']],
    ['the problem with the system is the museum', []],
    ["I'm hungry", ['dad:hungry']],
    ['im so tired!', ['dad:tired']],
    ['I’m exhausted', ['dad:exhausted']],
    ['i am tired', ['dad:tired']],
    ["I'm back", []],
    ["I'm fine", []],
    ["I'm going to the store, hungry", []],
    ['i am here', []],
    ["I can't do this", ['attitude:attitude']],
    ['i cant even', ['attitude:attitude']],
    ['I cannot dance.', ['attitude:attitude']],
    ["I can't figure out why the compiler keeps crashing on this file", []],
    ["I can't stand this awful bug", []],
    ["I can't do this anymore", []],
    ["I can't cope", []],
    ["I can't sleep", []],
    ["I can't wait", []],
    ["I can't believe it", []],
    ['no pun intended', ['intended:intended']],
    ['pun very much intended', ['intended:intended']],
    ['puns were not intended', ['intended:intended']],
    ['proved the lemma trivially', ['jargon:lemma', 'jargon:trivial']],
    ['use `functor` here', []],
    ['```\nfunctor\n```', []],
    ['see https://example.com/functor', []],
    ['<:functor:123>', []]
  ] as const) {
    it(`finds ${expected.length ? expected.join(', ') : 'nothing'} in ${JSON.stringify(text)}`, () => {
      assert.deepStrictEqual(found(text), expected)
    })
  }

  it('fills the pun lines with the word, name and pronoun', () => {
    const text = (s: string) => findPuns(s, 'donbot')[0]!.text()
    assert.match(text('the functor is lovely'), /^Functor\? /)
    assert.match(text('the pilgrim'), /^Pilgrim\? .*'im/)
    assert.match(text('proved the theorem'), /^Theorem\? .*'em/)
    const dad = text('im so tired!')
    assert.match(dad, /So tired/)
    assert.match(dad, /donbot/)
  })

  it('triggers every in-joke from a natural sample', () => {
    const samples: Record<string, string> = {
      monad: 'is it a monad', monoid: 'lists form a monoid', yoneda: 'by yoneda', category: 'learning category theory',
      diagram: 'the diagram chase works', abelian: 'an abelian group', isomorphism: 'they are isomorphic',
      univalence: 'assume univalence', homotopy: 'a homotopy between them', cubical: 'cubical agda is neat',
      typecheck: "it typechecks now", postulate: 'just postulate it', agda: 'wrote it in Agda', haskell: 'Haskell again',
      lazy: 'lazy evaluation bit me', ycombinator: 'the Y combinator', currying: 'currying is handy',
      lemma: 'need a lemma', zorn: "use Zorn's lemma", choice: 'the axiom of choice', banach: 'Banach-Tarski is wild',
      godel: 'Gödel ruined it', fermat: 'Fermat said so', hilbert: 'a Hilbert space', wlog: 'WLOG assume x > 0',
      contradiction: 'proof by contradiction', topology: 'topology class', recursion: 'recursion is fun',
      induction: 'by induction on n', trivial: 'that is trivial', regex: 'write a regex', naming: 'off by one again',
      halting: 'the halting problem', ub: 'undefined behavior in C', pnp: 'is P = NP', turing: 'CSS is Turing complete',
      segfault: 'it segfaulted', null: 'null pointer again', float: 'floating point maths', race: 'a race condition',
      deadlock: 'we deadlocked', udp: 'over UDP', tcp: 'TCP handshake', dns: 'the DNS is down',
      forcepush: 'I force pushed', borrow: 'fighting the borrow checker', nan: 'got NaN back'
    }
    for (const key of Object.keys(JARGON)) {
      assert.ok(samples[key], `no sample for ${key}`)
      assert.ok(found(samples[key]).includes(`jargon:${key}`), key)
    }
  })

  it('stays quiet on everyday chat', () => {
    for (const text of [
      'he admitted it was late', 'what category is this in', 'a nan bread with curry', 'banana for scale',
      'that was a close race', 'no conditions apply', 'the hotel was full', 'I pushed the door', 'let me check'
    ]) {
      assert.deepStrictEqual(found(text).filter(k => k.startsWith('jargon:')), [], text)
    }
  })
})

describe('Puns', () => {
  const state = setupRobot('Puns.ts')
  let t: ReturnType<typeof clock>

  beforeEach(() => {
    t = clock(1_000_000_000_000)
    setRandomSource(() => 0)
  })

  const fail = () => setRandomSource(c => Math.floor(0.999 * c))

  it('sends a pun when the roll succeeds, in its own name', async () => {
    const { robot, sent, say } = chat(state)
    await say('functor')
    t.advance(PUN_COOLDOWN_MS)
    await say("I'm hungry")
    assert.strictEqual(sent.length, 2)
    assert.match(sent[0]!, /^Functor\? /)
    assert.match(sent[1]!, new RegExp(`Hungry.*${robot.name}`))
  })

  it('prefers a specific joke, falling back to a word pun once it was used', async () => {
    const { sent, say } = chat(state)
    await say('no pun intended, the functor')
    t.advance(PUN_COOLDOWN_MS)
    await say('no pun intended, the functor')
    assert.strictEqual(sent.length, 2)
    assert.doesNotMatch(sent[0]!, /Functor/)
    assert.match(sent[1]!, /^Functor\? /)
  })

  it('stays quiet when the roll fails, without starting the cooldown', async () => {
    const { sent, say } = chat(state)
    fail()
    await say('functor')
    assert.deepStrictEqual(sent, [])
    setRandomSource(() => 0)
    await say('functor')
    assert.strictEqual(sent.length, 1)
  })

  it('ignores messages addressed to the bot', async () => {
    const { sent, ask } = chat(state)
    await ask('what is a functor')
    assert.deepStrictEqual(sent, [])
  })

  it('waits out the cooldown per channel', async () => {
    const { sent, say } = chat(state)
    await say('functor')
    await say('theorem')
    assert.strictEqual(sent.length, 1)
    await say('theorem', { room: 'other-room' })
    assert.strictEqual(sent.length, 2)
    t.advance(PUN_COOLDOWN_MS)
    await say('theorem')
    assert.match(sent.at(-1)!, /^Theorem\? /)
  })

  it('does not pun the same word twice in a channel within the window', async () => {
    const { sent, say } = chat(state)
    await say('functor')
    t.advance(PUN_COOLDOWN_MS)
    await say('functor')
    assert.strictEqual(sent.length, 1)
    t.advance(REPEAT_WINDOW_MS)
    await say('functor')
    assert.strictEqual(sent.length, 2)
  })

  it('reports the chance per kind', async () => {
    const { sent, ask } = chat(state)
    await ask('puns chances')
    assert.match(sent.at(-1)!, /knew-her 31%, knew-'em 31%, dad jokes 31%, attitude 31%, pun intended 31%, in-jokes 31%/)
  })
})

describe('Puns policy', () => {
  const state = setupRobot(['Puns.ts', 'Policy.ts'], { owner: 'test-user' })

  beforeEach(() => {
    clock(1_000_000_000_000)
    setRandomSource(() => 0)
  })

  it('turns puns off and on per channel', async () => {
    inGuild(state.robot, 'g1', ['test-room', 'other-room'], 'casual')
    const { sent, say, ask } = chat(state)
    await ask('puns off')
    assert.match(sent.at(-1)!, /^Puns: off for this channel\.$/)
    await say('functor')
    assert.strictEqual(sent.length, 1)
    await say('functor', { room: 'other-room' })
    assert.strictEqual(sent.length, 2)
    await ask('puns on')
    assert.match(sent.at(-1)!, /^Puns: on for this channel\.$/)
    await say('functor')
    assert.match(sent.at(-1)!, /^Functor\? /)
  })

  it('reports status', async () => {
    inGuild(state.robot, 'g1', ['test-room'], 'casual')
    const { sent, ask } = chat(state)
    await ask('puns')
    assert.match(sent.at(-1)!, /^Puns: on here/)
    await ask('puns off')
    await ask('puns status')
    assert.match(sent.at(-1)!, /^Puns: off here/)
  })

  it('stays quiet in a professional server', async () => {
    inGuild(state.robot, 'g2', ['test-room'])
    const { sent, say } = chat(state)
    await say('functor')
    assert.deepStrictEqual(sent, [])
  })
})

describe('Puns feedback scoring', () => {
  const now = 1_000_000_000_000
  const record = (votes: Record<string, 1 | -1>, at = now, room = 'r', kind = 'her' as const) =>
    ({ id: String(Math.random()), room, kind, at, votes })

  it('starts at the base chance', () => {
    assert.strictEqual(chanceFor(feedbackFor([], 'r', 'her', now)), PUN_CHANCE)
  })
  it('nudges the chance up on one like, down on one dislike', () => {
    const up = chanceFor(feedbackFor([record({ a: 1 })], 'r', 'her', now))
    const down = chanceFor(feedbackFor([record({ a: -1 })], 'r', 'her', now))
    assert.ok(up > PUN_CHANCE && up < MAX_CHANCE, String(up))
    assert.ok(down < PUN_CHANCE && down > MIN_CHANCE, String(down))
  })
  it('stays within bounds however lopsided', () => {
    const loved = Array.from({ length: 50 }, () => record({ a: 1, b: 1, c: 1 }))
    const hated = Array.from({ length: 50 }, () => record({ a: -1, b: -1, c: -1 }))
    assert.strictEqual(chanceFor(feedbackFor(loved, 'r', 'her', now)), MAX_CHANCE)
    assert.strictEqual(chanceFor(feedbackFor(hated, 'r', 'her', now)), MIN_CHANCE)
  })
  it('pulls back toward the base chance on unreacted puns', () => {
    const loved = [record({ a: 1, b: 1 })]
    const diluted = [...loved, record({}), record({}), record({})]
    assert.ok(feedbackFor(diluted, 'r', 'her', now) < feedbackFor(loved, 'r', 'her', now))
  })
  it('fades old feedback', () => {
    const fresh = feedbackFor([record({ a: -1, b: -1 })], 'r', 'her', now)
    const old = feedbackFor([record({ a: -1, b: -1 }, now - 4 * FEEDBACK_HALF_LIFE_MS)], 'r', 'her', now)
    assert.ok(old > fresh && old < 0)
  })
  it('keeps rooms and kinds separate', () => {
    const records = [record({ a: -1, b: -1 })]
    assert.strictEqual(feedbackFor(records, 'other', 'her', now), 0)
    assert.strictEqual(feedbackFor(records, 'r', 'dad', now), 0)
  })
})

describe('Puns reaction feedback', () => {
  const state = setupRobot('Puns.ts', { deferLoad: true })
  let t: ReturnType<typeof clock>
  let client: EventEmitter

  beforeEach(async () => {
    t = clock(1_000_000_000_000)
    setRandomSource(() => 0)
    sendReturnsIds(state.robot, 'msg')
    client = await fakeClient(state, { user: { id: 'bot-id' } })
  })

  const react = (emoji: string, messageId: string, userId = 'fan', { bot = false, remove = false, channelId }: { bot?: boolean, remove?: boolean, channelId?: string } = {}) =>
    client.emit(remove ? 'messageReactionRemove' : 'messageReactionAdd', { partial: true, emoji: { name: emoji }, message: { id: messageId, channelId } }, { id: userId, bot })
  // pun once, react, then read the chances
  const chances = async (reactions: () => void) => {
    const { sent, say, ask } = chat(state)
    await say('functor')
    reactions()
    await ask('puns chances')
    return sent.at(-1)!
  }

  for (const [name, reactions, expected] of [
    ['raises the chance on likes, for that kind only', () => { react('😂', 'msg-1', 'a'); react('🤣', 'msg-1', 'b') }, /knew-her 54%.*knew-'em 31%/],
    ['lowers it on dislikes', () => { react('🙄', 'msg-1', 'a'); react('👎', 'msg-1', 'b') }, /knew-her 18%/],
    ['counts each person once per pun, latest reaction wins', () => { react('😂', 'msg-1', 'a'); react('🤣', 'msg-1', 'a'); react('🙄', 'msg-1', 'a') }, /knew-her 24%/],
    ['withdraws a vote when its reaction is removed', () => { react('😂', 'msg-1', 'a'); react('😂', 'msg-1', 'a', { remove: true }) }, /knew-her 31%/],
    ['ignores bots, other emoji and other messages', () => { react('😂', 'msg-1', 'a', { bot: true }); react('🐙', 'msg-1', 'b'); react('😂', 'not-a-pun', 'c') }, /knew-her 31%/]
  ] as const) {
    it(name, async () => {
      assert.match(await chances(reactions), expected)
    })
  }

  it('ignores reactions where puns are off', async () => {
    inGuild(state.robot, 'g1', ['quiet'])
    assert.match(await chances(() => react('😂', 'msg-1', 'a', { channelId: 'quiet' })), /knew-her 31%/)
  })

  it('uses the learned chance for the roll', async () => {
    const { sent, say } = chat(state)
    await say('functor')
    for (const id of ['a', 'b']) react('🙄', 'msg-1', id)
    t.advance(PUN_COOLDOWN_MS)
    // passes at the base chance but not the lowered one
    setRandomSource(c => Math.floor(0.25 * c))
    await say('compressor')
    await say('theorem')
    assert.strictEqual(sent.length, 2)
    assert.match(sent[1]!, /^Theorem\? .*'em/)
  })
})
