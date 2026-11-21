import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, sendReturnsIds, inGuild } from './helpers/setup.ts'
import { clock, fakeClient, react } from './helpers/fakes.ts'

describe('StarReact', () => {
  const state = setupRobot('StarReact.ts', { deferLoad: true })

  it('loads without a discord client', async () => {
    await assert.doesNotReject(state.loadScript())
  })

  it('announces a star from a person', async () => {
    const client = await fakeClient(state)
    const sent = collect(state.robot)
    await react(client, '⭐')
    assert.deepStrictEqual(sent, ['⭐ bob starred a message from alice'])
  })

  for (const [name, emoji, opts] of [
    ['bots', '⭐', { bot: true }],
    ['other emoji', '👍', {}]
  ] as const) {
    it(`ignores ${name}`, async () => {
      const client = await fakeClient(state)
      const sent = collect(state.robot)
      await react(client, emoji, opts)
      assert.deepStrictEqual(sent, [])
    })
  }

  it('stays quiet in professional servers', async () => {
    const client = await fakeClient(state)
    inGuild(state.robot, 'g1', ['pro-room'])
    const sent = collect(state.robot)
    await react(client, '⭐', { room: 'pro-room' })
    assert.deepStrictEqual(sent, [])
  })

  it('announces each star once, rate limited by the guard', async () => {
    const t = clock(1_000_000)
    sendReturnsIds(state.robot, 'announce')
    const client = await fakeClient(state)
    const sent = collect(state.robot)
    const star = (id: string, msg: string, room = 'room-1') => react(client, '⭐', { by: id, user: { id }, room, message: { id: msg } })
    await star('bob', 'msg-1')
    await star('bob', 'msg-1')
    await star('carol', 'msg-2')
    await star('bob', 'msg-3', 'room-2')
    assert.strictEqual(sent.length, 2)
    // own announcements
    t.advance(60_000)
    await star('carol', 'announce-1')
    assert.strictEqual(sent.length, 2)
  })
})
