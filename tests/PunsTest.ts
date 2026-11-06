import { describe, it, mock, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { User, DiscordClient } from 'hubot'

import { setupRobot, brainUser, collect } from './helpers/setup.ts'

import { setRandomSource } from '../scripts/lib/random.ts'
import { JARGON } from '../scripts/lib/punJargon.ts'
import {
  findPuns, feedbackFor, chanceFor, PUN_CHANCE, MIN_CHANCE, MAX_CHANCE, PUN_COOLDOWN_MS, REPEAT_WINDOW_MS, FEEDBACK_HALF_LIFE_MS
} from '../scripts/Puns.ts'

const texts = (text: string) => {
  setRandomSource(() => 0)
  const result = findPuns(text, 'donbot').map(p => p.text())
  setRandomSource(null)
  return result
}

describe('Puns detection', () => {
  it('makes knew-her puns for rare -er/-or words', () => {
    assert.deepStrictEqual(texts('the functor is lovely'), ['Functor? I barely knew her!'])
    assert.deepStrictEqual(texts('two functors'), ['Functor? I barely knew her!'])
  })
  it('skips common -er/-or words', () => {
    assert.deepStrictEqual(texts('the printer and the manager are faster and better'), [])
  })
  it("makes knew-'em puns, with 'im for -im words", () => {
    assert.deepStrictEqual(texts('proved the theorem'), ["Theorem? I barely knew 'em!"])
    assert.deepStrictEqual(texts('the pilgrim'), ["Pilgrim? I barely knew 'im!"])
  })
  it("skips common -em/-um words", () => {
    assert.deepStrictEqual(texts('the problem with the system is the museum'), [])
  })
  it('makes dad jokes for short uncommon "i\'m" messages only', () => {
    assert.deepStrictEqual(texts("I'm hungry"), ["Hi Hungry, I'm donbot!"])
    assert.deepStrictEqual(texts('im so tired!'), ["Hi So tired, I'm donbot!"])
    assert.deepStrictEqual(texts("I’m exhausted"), ["Hi Exhausted, I'm donbot!"])
    assert.deepStrictEqual(texts('i am tired'), ["Hi Tired, I'm donbot!"])
    for (const text of ["I'm back", "I'm fine", "I'm going to the store, hungry", 'i am here']) {
      assert.deepStrictEqual(texts(text), [], text)
    }
  })
  it('varies dad-joke phrasing', () => {
    setRandomSource(c => c - 1)
    assert.deepStrictEqual(findPuns("I'm hungry", 'donbot').map(p => p.text()), ["Hi Hungry! I'm dad. Wait, no, I'm donbot."])
    setRandomSource(null)
  })
  it('answers short "i can\'t" messages', () => {
    assert.deepStrictEqual(texts("I can't do this"), ['Not with that attitude!'])
    assert.deepStrictEqual(texts('i cant even'), ['Not with that attitude!'])
    assert.deepStrictEqual(texts('I cannot dance.'), ['Not with that attitude!'])
  })
  it('leaves "i can\'t" alone when long, upset, distressed or not defeat', () => {
    for (const text of [
      "I can't figure out why the compiler keeps crashing on this file",
      "I can't stand this awful bug",
      "I can't do this anymore",
      "I can't cope",
      "I can't sleep",
      "I can't wait",
      "I can't believe it"
    ]) {
      assert.deepStrictEqual(texts(text), [], text)
    }
  })
  it('responds to pun intended', () => {
    for (const text of ['no pun intended', 'pun intended', 'pun very much intended', 'puns were not intended']) {
      assert.deepStrictEqual(texts(text), ['Pun appreciated.'], text)
    }
  })
  it('has in-jokes for math and programming jargon', () => {
    assert.deepStrictEqual(texts('is it a monad'), ["A monad is just a monoid in the category of endofunctors, what's the problem?"])
    assert.deepStrictEqual(texts('write a regex for it'), ['Now you have two problems.'])
    assert.deepStrictEqual(texts('the halting problem'), ["I'd tell you a halting problem joke, but I can't tell if it ends."])
    assert.deepStrictEqual(texts('proved the lemma trivially'), ['Lemma? Sounds like a dilemma.', 'Proof left as an exercise for the reader.'])
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
      assert.ok(findPuns(samples[key]!, 'donbot').some(p => p.kind === 'jargon' && p.word === key), key)
    }
  })
  it('stays quiet on everyday chat', () => {
    for (const text of [
      'he admitted it was late', 'what category is this in', 'a nan bread with curry', 'banana for scale',
      'that was a close race', 'no conditions apply', 'the hotel was full', 'I pushed the door', 'let me check'
    ]) {
      assert.deepStrictEqual(findPuns(text, 'donbot').filter(p => p.kind === 'jargon'), [], text)
    }
  })
  it('ignores code, links and discord tokens', () => {
    for (const text of ['use `functor` here', '```\nfunctor\n```', 'see https://example.com/functor', '<:functor:123>']) {
      assert.deepStrictEqual(texts(text), [], text)
    }
  })
})

describe('Puns testing Hubot scripts', () => {
  const state = setupRobot('Puns.ts')
  let now: number
  let user: User

  beforeEach(() => {
    now = 1_000_000_000_000
    mock.method(Date, 'now', () => now)
    setRandomSource(() => 0)
    user = brainUser(state.robot, 'test-user', 'test user')
  })

  const say = (text: string, room = 'test-room') => state.robot.adapter.say(user, text, room)

  it('sends a pun when the roll succeeds', async () => {
    const sent = collect(state.robot)
    await say('functor')
    assert.deepStrictEqual(sent, ['Functor? I barely knew her!'])
  })
  it('uses its own name in dad jokes', async () => {
    const sent = collect(state.robot)
    await say("I'm hungry")
    assert.deepStrictEqual(sent, [`Hi Hungry, I'm ${state.robot.name}!`])
  })
  it('prefers a specific joke over a word-shape pun', async () => {
    const sent = collect(state.robot)
    await say('no pun intended, the functor')
    assert.deepStrictEqual(sent, ['Pun appreciated.'])
  })
  it('falls back to a word-shape pun when the specific joke was just used', async () => {
    const sent = collect(state.robot)
    await say('no pun intended')
    now += PUN_COOLDOWN_MS
    await say('no pun intended, the functor')
    assert.deepStrictEqual(sent, ['Pun appreciated.', 'Functor? I barely knew her!'])
  })
  it('stays quiet when the roll fails', async () => {
    setRandomSource(c => Math.floor(0.999 * c))
    const sent = collect(state.robot)
    await say('functor')
    assert.deepStrictEqual(sent, [])
  })
  it('stays quiet for common words', async () => {
    const sent = collect(state.robot)
    for (const word of ['faster', 'better', 'container', 'printer', 'manager', 'compiler', 'problem']) await say(word)
    assert.deepStrictEqual(sent, [])
  })
  it('ignores messages addressed to the bot', async () => {
    const sent = collect(state.robot)
    await say(`${state.robot.name} what is a functor`)
    assert.deepStrictEqual(sent, [])
  })
  it('waits out the cooldown per channel', async () => {
    const sent = collect(state.robot)
    await say('functor')
    await say('theorem')
    assert.strictEqual(sent.length, 1)
    await say('theorem', 'other-room')
    assert.strictEqual(sent.length, 2)
    now += PUN_COOLDOWN_MS
    await say('theorem')
    assert.deepStrictEqual(sent.at(-1), "Theorem? I barely knew 'em!")
  })
  it('does not pun the same word twice in a channel within the window', async () => {
    const sent = collect(state.robot)
    await say('functor')
    now += PUN_COOLDOWN_MS
    await say('functor')
    assert.strictEqual(sent.length, 1)
    now += REPEAT_WINDOW_MS
    await say('functor')
    assert.strictEqual(sent.length, 2)
  })
  it('a failed roll does not start the cooldown', async () => {
    const sent = collect(state.robot)
    setRandomSource(c => Math.floor(0.999 * c))
    await say('functor')
    setRandomSource(() => 0)
    await say('functor')
    assert.strictEqual(sent.length, 1)
  })

  describe('channel toggle', () => {
    it('turns puns off and on per channel', async () => {
      const sent = collect(state.robot)
      await say(`${state.robot.name} puns off`)
      assert.match(sent.at(-1)!, /^Puns off in this channel/)
      await say('functor')
      assert.strictEqual(sent.length, 1)
      await say('functor', 'other-room')
      assert.strictEqual(sent.length, 2)

      await say(`${state.robot.name} puns on`)
      assert.match(sent.at(-1)!, /^Puns on in this channel/)
      await say('functor')
      assert.strictEqual(sent.at(-1), 'Functor? I barely knew her!')
    })
    it('reports status with who turned it off', async () => {
      const sent = collect(state.robot)
      await say(`${state.robot.name} puns`)
      assert.match(sent.at(-1)!, /are on/)
      await say(`${state.robot.name} puns off`)
      await say(`${state.robot.name} puns status`)
      assert.match(sent.at(-1)!, /are off .*test user/)
    })
    it('reports the chance per kind in the status', async () => {
      const sent = collect(state.robot)
      await say(`${state.robot.name} puns`)
      assert.match(sent.at(-1)!, /knew-her 31%, knew-'em 31%, dad jokes 31%, attitude 31%, pun intended 31%, in-jokes 31%/)
    })
  })
})

describe('Puns feedback scoring', () => {
  const now = 1_000_000_000_000
  const record = (votes: Record<string, 1 | -1>, at = now, room = 'r', kind = 'her' as const) =>
    ({ id: String(Math.random()), room, kind, at, votes })

  it('starts at the base chance', () => {
    assert.strictEqual(chanceFor(feedbackFor([], 'r', 'her', now)), PUN_CHANCE)
  })
  it('one like nudges the chance up, one dislike down', () => {
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
  it('unreacted puns pull back toward the base chance', () => {
    const loved = [record({ a: 1, b: 1 })]
    const diluted = [...loved, record({}), record({}), record({})]
    assert.ok(feedbackFor(diluted, 'r', 'her', now) < feedbackFor(loved, 'r', 'her', now))
  })
  it('old feedback fades', () => {
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
  let now: number
  let user: User
  let client: EventEmitter
  let nextId: number

  beforeEach(async () => {
    now = 1_000_000_000_000
    nextId = 0
    mock.method(Date, 'now', () => now)
    setRandomSource(() => 0)
    user = brainUser(state.robot, 'test-user', 'test user')
    client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    state.robot.adapter.client = client as unknown as DiscordClient
    const send = state.robot.adapter.send.bind(state.robot.adapter)
    // like the discord adapter, resolve to the sent messages
    const adapter = state.robot.adapter as unknown as { send: (...args: Parameters<typeof send>) => Promise<unknown> }
    mock.method(adapter, 'send', async (...args: Parameters<typeof send>) => {
      await send(...args)
      return [{ id: `msg-${++nextId}` }]
    })
    await state.loadScript()
  })

  const say = (text: string, room = 'test-room') => state.robot.adapter.say(user, text, room)
  const react = (emoji: string, messageId: string, userId = 'fan', bot = false, event = 'messageReactionAdd') =>
    client.emit(event, { partial: true, emoji: { name: emoji }, message: { id: messageId } }, { id: userId, bot })
  const status = async () => {
    const sent = collect(state.robot)
    await say(`${state.robot.name} puns`)
    return sent.at(-1)!
  }

  it('likes raise the chance for that kind in that channel', async () => {
    await say('functor')
    react('😂', 'msg-1', 'a')
    react('🤣', 'msg-1', 'b')
    const reply = await status()
    assert.match(reply, /knew-her 54%/)
    assert.match(reply, /knew-'em 31%/)
  })
  it('dislikes lower it', async () => {
    await say('functor')
    react('🙄', 'msg-1', 'a')
    react('👎', 'msg-1', 'b')
    assert.match(await status(), /knew-her 18%/)
  })
  it('counts each person once per pun, latest reaction wins', async () => {
    await say('functor')
    react('😂', 'msg-1', 'a')
    react('🤣', 'msg-1', 'a')
    react('🙄', 'msg-1', 'a')
    assert.match(await status(), /knew-her 24%/)
  })
  it('removing a reaction withdraws the vote', async () => {
    await say('functor')
    react('😂', 'msg-1', 'a')
    react('😂', 'msg-1', 'a', false, 'messageReactionRemove')
    assert.match(await status(), /knew-her 31%/)
  })
  it('ignores bots, other emoji and other messages', async () => {
    await say('functor')
    react('😂', 'msg-1', 'a', true)
    react('🐙', 'msg-1', 'b')
    react('😂', 'not-a-pun', 'c')
    assert.match(await status(), /knew-her 31%/)
  })
  it('uses the learned chance for the roll', async () => {
    await say('functor')
    for (const id of ['a', 'b']) react('🙄', 'msg-1', id)
    now += PUN_COOLDOWN_MS
    // a roll that passes at the base chance but not at the lowered one
    setRandomSource(c => Math.floor(0.25 * c))
    const sent = collect(state.robot)
    await say('compressor')
    await say('theorem')
    assert.deepStrictEqual(sent, ["Theorem? I barely knew 'em!"])
  })
})
