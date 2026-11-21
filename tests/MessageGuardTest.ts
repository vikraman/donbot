import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { TextMessage } from 'hubot'
import type { DiscordClient } from 'hubot'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

import { unescapeMarkdown } from '../scripts/MessageGuard.ts'

describe('MessageGuard', () => {
  const state = setupRobot(['MessageGuard.ts', 'Wins.ts', 'Kudos.ts'], { deferLoad: true })

  const send = async (text: string, id: string, userId = 'u1') => {
    const user = brainUser(state.robot, userId, 'alice')
    user.room = 'room'
    await state.robot.receive(new TextMessage(user, text, id))
  }

  it('drops markdown escapes clients add, so a \\| splits like a |', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send(`@${state.robot.name} win fixed snake\\_case \\| and C:\\Users`, 'm0')
    await send(`@${state.robot.name} wins`, 'm0b')
    assert.match(sent.at(-1)!, /fixed snake_case \| and C:\\Users/)
    assert.strictEqual(unescapeMarkdown('a \\* b \\\\ c \\d'), 'a * b \\ c \\d')
  })
  it("replaces the adapter's mid-line splitting", async () => {
    const adapter = state.robot.adapter as unknown as { breakUpMessage?: (text: string) => string[] }
    adapter.breakUpMessage = text => [text.slice(0, 2000), text.slice(1999)]
    await state.loadScript()
    const text = Array.from({ length: 200 }, (_, i) => `line ${i} of a long help reply`).join('\n')
    const chunks = adapter.breakUpMessage(text)
    assert.ok(chunks.length > 1 && chunks.every(c => c.length <= 2000))
    assert.strictEqual(chunks.join('\n'), text)
  })
  it('drops a repeat of the same message, as from a link preview loading', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send(`@${state.robot.name} win shipped https://example.com`, 'm1')
    await send(`@${state.robot.name} win shipped https://example.com`, 'm1')
    assert.strictEqual(sent.length, 1)
    assert.strictEqual((state.robot.brain.get<unknown[]>('log:win') ?? []).length, 1)
  })
  it('drops an edit to a message a command already acted on', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send(`@${state.robot.name} win one thing`, 'm2')
    await send(`@${state.robot.name} win one thing, edited`, 'm2')
    await send('coffee++', 'm3')
    await send('coffee++ for beans', 'm3')
    assert.strictEqual(sent.length, 2)
  })
  it('acts on an edit that fixes a typo no command picked up', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    await send(`@${state.robot.name} wni shipped it`, 'm4')
    await send(`@${state.robot.name} win shipped it`, 'm4')
    assert.strictEqual(sent.length, 1)
    assert.match(sent[0]!, /<@u1>/)
  })
  it('lets messages without ids through every time', async () => {
    await state.loadScript()
    const sent = collect(state.robot)
    const user = brainUser(state.robot, 'u1', 'alice')
    await state.robot.adapter.say(user, `@${state.robot.name} win a`, 'room')
    await state.robot.adapter.say(user, `@${state.robot.name} win a`, 'room')
    assert.strictEqual(sent.length, 2)
  })
  it('only allows user pings in outgoing messages', async () => {
    const client = { options: {} as Record<string, unknown> }
    state.robot.adapter.client = client as unknown as DiscordClient
    await state.loadScript()
    assert.deepStrictEqual(client.options.allowedMentions, { parse: ['users'], repliedUser: true })
  })
})
