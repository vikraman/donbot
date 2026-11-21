import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'

import { configureLines, defineLines, keptFor, poolFor, refillAi, scoresFor } from '../scripts/lib/lines.ts'
import { policyFor } from '../scripts/lib/policy.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, chat, brainUser, inGuild } from './helpers/setup.ts'
import { fakeClient, mockGemini, settle } from './helpers/fakes.ts'

const AI = { about: 'x', slots: ['who'] }

describe('Whimsy', () => {
  const state = setupRobot('Whimsy.ts', { envVars: ['GEMINI_API_KEY'], owner: 'u1', deferLoad: true })

  const withClient = () => fakeClient(state, { user: { id: 'bot-id' } })

  const react = async (client: EventEmitter, emoji: string, content: string, { userId = 'u1', remove = false, author = 'bot-id', room = 'room' } = {}) => {
    const reaction = { partial: false, emoji: { name: emoji }, message: { id: 'm1', channelId: room, author: { id: author }, content } }
    client.emit(remove ? 'messageReactionRemove' : 'messageReactionAdd', reaction, { id: userId, bot: false })
    await settle()
  }

  it('scores bot lines from reactions, once per person, undone on removal', async () => {
    const client = await withClient()
    setRandomSource(() => 0)
    const line = defineLines('whimsy.test', { fallback: ['Hello, {who}.'] })
    const text = line({ who: 'ada' })
    await react(client, '😂', `🎉 ${text}`)
    await react(client, '😂', `🎉 ${text}`)
    assert.deepStrictEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': 1 })
    await react(client, '🙄', text, { userId: 'u2' })
    assert.deepStrictEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': 0 })
    await react(client, '😂', `🎉 ${text}`, { remove: true })
    assert.deepStrictEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': -1 })
    // other emoji, and other people's messages, are ignored
    await react(client, '⭐', text, { userId: 'u3' })
    await react(client, '😂', text, { userId: 'u4', author: 'someone' })
    assert.deepStrictEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': -1 })
  })
  it('ignores reactions where learning from them is off', async () => {
    const client = await withClient()
    inGuild(state.robot, 'g1', ['quiet'], 'casual')
    policyFor(state.robot).update(d => { d.channels.quiet = { on: [], off: ['lines.scoring'] } })
    setRandomSource(() => 0)
    const text = defineLines('whimsy.off', { fallback: ['Hi, {who}.'] })({ who: 'ada' })
    await react(client, '😂', text, { room: 'quiet' })
    assert.deepStrictEqual(scoresFor('whimsy.off'), {})
  })
  it('counts one vote per person however many emoji they use', async () => {
    const client = await withClient()
    setRandomSource(() => 0)
    const line = defineLines('whimsy.multi', { fallback: ['Hi, {who}.'] })
    const text = line({ who: 'ada' })
    await react(client, '😂', text)
    await react(client, '🔥', text)
    await react(client, '❤️', text)
    assert.deepStrictEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': 1 })
    await react(client, '😂', text, { remove: true })
    assert.deepStrictEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': 1 })
    // mixed signals cancel out
    await react(client, '🙄', text)
    await react(client, '👎', text)
    await react(client, '🥱', text)
    assert.deepStrictEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': -1 })
    await react(client, '🙄', text, { remove: true })
    await react(client, '👎', text, { remove: true })
    await react(client, '🥱', text, { remove: true })
    await react(client, '🔥', text, { remove: true })
    await react(client, '❤️', text, { remove: true })
    assert.deepStrictEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': 0 })
  })
  it('keeps an ai line on two people laughing, not one person\'s two emoji', async () => {
    process.env.GEMINI_API_KEY = 'key'
    mockGemini(['Splendid, {who}.'])
    const client = await withClient()
    const line = defineLines('whimsy.keep', { fallback: ['Static, {who}.'], ai: AI })
    await refillAi('whimsy.keep')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    const text = line({ who: 'bo' })
    assert.strictEqual(text, 'Splendid, bo.')
    await react(client, '🤣', text)
    await react(client, '👍', text)
    assert.deepStrictEqual(keptFor('whimsy.keep'), [])
    await react(client, '👍', text, { userId: 'u2' })
    assert.deepStrictEqual(keptFor('whimsy.keep'), ['Splendid, {who}.'])
  })
  it('turns ai lines off per channel', async () => {
    process.env.GEMINI_API_KEY = 'key'
    mockGemini(['Fresh, {who}.'])
    await state.loadScript()
    await state.robot.loadFile('./scripts', 'Policy.ts')
    inGuild(state.robot, 'g1', ['quiet', 'loud'], 'casual')
    const { sent, ask } = chat(state, { id: 'u1', name: 'alice', room: 'quiet' })
    await ask('ai lines off')
    assert.match(sent[0]!, /^AI-written lines: off for this channel\.$/)
    const line = defineLines('whimsy.room', { fallback: ['Static, {who}.'], ai: AI })
    await refillAi('whimsy.room')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    assert.strictEqual(line({ who: 'x' }, { room: 'quiet' }), 'Static, x.')
    assert.strictEqual(line({ who: 'x' }, { room: 'loud' }), 'Fresh, x.')
  })
  it('reports line stats and lets the owner refill', async () => {
    process.env.GEMINI_API_KEY = 'key'
    mockGemini(['One, {who}.', 'Two, {who}.'])
    await state.loadScript()
    defineLines('whimsy.stats', { fallback: ['x {who}'], ai: AI })
    const { robot, sent, ask } = chat(state, { id: 'u2', name: 'bob', room: 'room' })
    const owner = brainUser(robot, 'u1', 'alice')
    await ask('whimsy refill')
    assert.strictEqual(sent[0], 'Only my owner can do that.')
    await ask('whimsy refill', { user: owner })
    assert.match(sent[1]!, /^Added \d+ fresh lines across \d+ kinds\. \d+ of 20 Gemini requests used today\.$/)
    assert.strictEqual(poolFor('whimsy.stats').lines.length, 2)
    await ask('whimsy')
    assert.match(sent[2]!, /^✨ \d+ kinds of lines, \d+ with AI help: \d+ fresh AI lines waiting, 0 kept, 0 retired\./)
    assert.match(sent[2]!, /• whimsy\.stats: 2 fresh, 0 kept, 0 retired/)
    assert.doesNotMatch(sent[2]!, /whimsy\.test:/)
  })
})
