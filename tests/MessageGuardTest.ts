import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TextMessage } from 'hubot'
import type { DiscordClient } from 'hubot'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

describe('MessageGuard', () => {
  const state = setupRobot(['MessageGuard.ts', 'Wins.ts', 'Kudos.ts'], { deferLoad: true })

  const send = async (text: string, id: string, userId = 'u1') => {
    const user = brainUser(state.robot, userId, 'alice')
    user.room = 'room'
    await state.robot.receive(new TextMessage(user, text, id))
  }

  it('drops a repeat of the same message, as from a link preview loading', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send('@Dumbotheelephant win shipped https://example.com', 'm1')
    await send('@Dumbotheelephant win shipped https://example.com', 'm1')
    assert.equal(sent.length, 1)
    assert.equal((state.robot.brain.get<unknown[]>('log:win') ?? []).length, 1)
  })
  it('drops an edit to a message a command already acted on', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send('@Dumbotheelephant win one thing', 'm2')
    await send('@Dumbotheelephant win one thing, edited', 'm2')
    await send('coffee++', 'm3')
    await send('coffee++ for beans', 'm3')
    assert.equal(sent.length, 2)
  })
  it('acts on an edit that fixes a typo no command picked up', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send('@Dumbotheelephant wni shipped it', 'm4')
    await send('@Dumbotheelephant win shipped it', 'm4')
    assert.equal(sent.length, 1)
    assert.match(sent[0]!, /<@u1>/)
  })
  it('lets messages without ids through every time', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    const user = brainUser(state.robot, 'u1', 'alice')
    await state.robot.adapter.say(user, '@Dumbotheelephant win a', 'room')
    await state.robot.adapter.say(user, '@Dumbotheelephant win a', 'room')
    assert.equal(sent.length, 2)
  })
  it('only allows user pings in outgoing messages', async () => {
    const client = { options: {} as Record<string, unknown> }
    state.robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()
    assert.deepEqual(client.options.allowedMentions, { parse: ['users'], repliedUser: true })
  })
})
