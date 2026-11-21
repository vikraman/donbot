import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, inGuild } from './helpers/setup.ts'
import { fakeClient, tick } from './helpers/fakes.ts'

import { policyFor } from '../scripts/lib/policy.ts'

describe('Welcome', () => {
  const state = setupRobot('Welcome.ts', { deferLoad: true })

  it('says a short hello in a new server, not one it already knows', async () => {
    const client = await fakeClient(state)
    const posted: string[] = []
    const guild = (id: string) => ({ id, systemChannel: { send: async (text: string) => { posted.push(text) } } })
    client.emit('guildCreate', guild('new'))
    policyFor(state.robot).update(d => { d.guilds.known = { mode: 'casual', on: [], off: [] } })
    client.emit('guildCreate', guild('known'))
    client.emit('guildCreate', { id: 'quiet', systemChannel: null })
    await tick()
    assert.deepStrictEqual(posted, ["👋 Hi, I'm Dumbotheelephant, a helper bot. Start a message with `Dumbotheelephant` to talk to me; `Dumbotheelephant help` lists what I can do."])
  })

  it('waves at people joining, unless welcomes are off there', async () => {
    const client = await fakeClient(state)
    const reacted: string[] = []
    const join = (id: string, room: string, extra: Record<string, unknown> = {}) =>
      ({ id, type: 7, guildId: 'g1', channelId: room, author: { id: 'u9', bot: false }, react: async (emoji: string) => { reacted.push(`${id}:${emoji}`) }, ...extra })
    client.emit('messageCreate', join('m1', 'room'))
    client.emit('messageCreate', join('m2', 'room', { type: 0 }))
    client.emit('messageCreate', join('m3', 'room', { author: { id: 'b', bot: true } }))
    policyFor(state.robot).update(d => { d.channels.quiet = { on: [], off: ['welcome'] } })
    inGuild(state.robot, 'g1', ['quiet'])
    client.emit('messageCreate', join('m4', 'quiet'))
    await tick()
    assert.deepStrictEqual(reacted, ['m1:👋'])
  })
})
