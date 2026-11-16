import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import type { DiscordClient } from 'hubot'

import { configureLines, defineLines, keptFor, poolFor, refillAi, scoresFor } from '../scripts/lib/lines.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const gemini = (lines: unknown) => mock.method(global, 'fetch', async () => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(lines) }] } }] })
}))

describe('Whimsy', () => {
  const state = setupRobot('Whimsy.ts', { envVars: ['GEMINI_API_KEY', 'OWNER_USER_ID'], deferLoad: true })

  const withClient = async () => {
    const client = Object.assign(new EventEmitter(), { user: { id: 'bot-id' } })
    state.robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()
    return client
  }

  const react = async (client: EventEmitter, emoji: string, content: string, { userId = 'u1', remove = false, author = 'bot-id' } = {}) => {
    const reaction = { partial: false, emoji: { name: emoji }, message: { id: 'm1', channelId: 'room', author: { id: author }, content } }
    client.emit(remove ? 'messageReactionRemove' : 'messageReactionAdd', reaction, { id: userId, bot: false })
    await new Promise(resolve => setImmediate(resolve))
  }

  it('scores bot lines from reactions, once per person, undone on removal', async () => {
    const client = await withClient()
    setRandomSource(() => 0)
    const line = defineLines('whimsy.test', { fallback: ['Hello, {who}.'] })
    const text = line({ who: 'ada' })
    await react(client, '😂', `🎉 ${text}`)
    await react(client, '😂', `🎉 ${text}`)
    assert.deepEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': 1 })
    await react(client, '🙄', text, { userId: 'u2' })
    assert.deepEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': 0 })
    await react(client, '😂', `🎉 ${text}`, { remove: true })
    assert.deepEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': -1 })
    // other emoji, and other people's messages, are ignored
    await react(client, '⭐', text, { userId: 'u3' })
    await react(client, '😂', text, { userId: 'u4', author: 'someone' })
    assert.deepEqual(scoresFor('whimsy.test'), { 'Hello, {who}.': -1 })
  })
  it('counts one vote per person however many emoji they use', async () => {
    const client = await withClient()
    setRandomSource(() => 0)
    const line = defineLines('whimsy.multi', { fallback: ['Hi, {who}.'] })
    const text = line({ who: 'ada' })
    await react(client, '😂', text)
    await react(client, '🔥', text)
    await react(client, '❤️', text)
    assert.deepEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': 1 })
    await react(client, '😂', text, { remove: true })
    assert.deepEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': 1 })
    // mixed signals cancel out
    await react(client, '🙄', text)
    await react(client, '👎', text)
    await react(client, '🥱', text)
    assert.deepEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': -1 })
    await react(client, '🙄', text, { remove: true })
    await react(client, '👎', text, { remove: true })
    await react(client, '🥱', text, { remove: true })
    await react(client, '🔥', text, { remove: true })
    await react(client, '❤️', text, { remove: true })
    assert.deepEqual(scoresFor('whimsy.multi'), { 'Hi, {who}.': 0 })
  })
  it('does not keep an ai line on one person\'s two emoji', async () => {
    process.env.GEMINI_API_KEY = 'key'
    gemini(['Marvellous, {who}.'])
    const client = await withClient()
    const line = defineLines('whimsy.solo', { fallback: ['Static, {who}.'], ai: { about: 'x', slots: ['who'] } })
    await refillAi('whimsy.solo')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    const text = line({ who: 'bo' })
    assert.equal(text, 'Marvellous, bo.')
    await react(client, '🤣', text)
    await react(client, '👍', text)
    assert.deepEqual(keptFor('whimsy.solo'), [])
  })
  it('keeps an ai line after two laughs', async () => {
    process.env.GEMINI_API_KEY = 'key'
    gemini(['Splendid, {who}.'])
    const client = await withClient()
    const line = defineLines('whimsy.keep', { fallback: ['Static, {who}.'], ai: { about: 'x', slots: ['who'] } })
    await refillAi('whimsy.keep')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    const text = line({ who: 'bo' })
    assert.equal(text, 'Splendid, bo.')
    await react(client, '🤣', text)
    await react(client, '👍', text, { userId: 'u2' })
    assert.deepEqual(keptFor('whimsy.keep'), ['Splendid, {who}.'])
  })
  it('turns ai lines off per channel', async () => {
    process.env.GEMINI_API_KEY = 'key'
    gemini(['Fresh, {who}.'])
    await state.loadScript()
    const { robot } = state
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ai lines off', 'quiet')
    assert.match(sent[0]!, /^AI-written lines off in this channel/)
    const line = defineLines('whimsy.room', { fallback: ['Static, {who}.'], ai: { about: 'x', slots: ['who'] } })
    await refillAi('whimsy.room')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    assert.equal(line({ who: 'x' }, { room: 'quiet' }), 'Static, x.')
    assert.equal(line({ who: 'x' }, { room: 'loud' }), 'Fresh, x.')
  })
  it('reports line stats and lets the owner refill', async () => {
    process.env.OWNER_USER_ID = 'owner'
    process.env.GEMINI_API_KEY = 'key'
    gemini(['One, {who}.', 'Two, {who}.'])
    await state.loadScript()
    const { robot } = state
    defineLines('whimsy.stats', { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
    const owner = brainUser(robot, 'owner', 'boss')
    const user = brainUser(robot, 'u1', 'alice')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant whimsy refill', 'room')
    assert.equal(sent[0], 'Only my owner can do that.')
    await robot.adapter.say(owner, '@Dumbotheelephant whimsy refill', 'room')
    assert.match(sent[1]!, /^Added \d+ fresh lines across \d+ kinds\. \d+ of 20 Gemini requests used today\.$/)
    assert.equal(poolFor('whimsy.stats').lines.length, 2)
    await robot.adapter.say(user, '@Dumbotheelephant whimsy', 'room')
    assert.match(sent[2]!, /^✨ \d+ kinds of lines, \d+ with AI help: \d+ fresh AI lines waiting, 0 kept, 0 retired\./)
    assert.match(sent[2]!, /• whimsy\.stats: 2 fresh, 0 kept, 0 retired/)
    assert.doesNotMatch(sent[2]!, /whimsy\.test:/)
  })
})
