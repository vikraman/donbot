import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordClient } from 'hubot'

import { setupRobot, chat, brainUser } from './helpers/setup.ts'

const SIMPLE = /^Uptime: .+ \| Brain: connected \| All good\.$/

describe('Status', () => {
  // verbose counts span servers
  const state = setupRobot('Status.ts', { owner: 'test-user' })

  it('gives others the simple status even when asked for verbose', async () => {
    const { ask, sent } = chat(state, { id: 'someone', name: 'someone' })
    await ask('status verbose')
    assert.match(sent[0]!, SIMPLE)
  })

  for (const text of ['status', 'how are you']) {
    it(`reports a simple status for "${text}"`, async () => {
      const { ask, sent } = chat(state)
      await ask(text)
      assert.match(sent[0]!, SIMPLE)
    })
  }

  for (const text of ['status verbose', 'status detailed']) {
    it(`reports details for "${text}"`, async () => {
      const { ask, sent } = chat(state)
      await ask(text)
      for (const re of [/Uptime: /, /Memory: .+MB \(heap/, /Brain: connected \(.+\) — \d+ users, \d+ keys, [\d.]+ KB/, /Listeners: \d+/, /Node: v/, /Hubot: /]) {
        assert.match(sent[0]!, re)
      }
    })
  }

  it('counts users and keys in verbose brain info', async () => {
    brainUser(state.robot, 'another-user', 'another user')
    state.robot.brain.set('some:custom:key', 'value')
    const { ask, sent } = chat(state)
    await ask('status verbose')
    const match = sent[0]!.match(/Brain: connected \(.+\) — (\d+) users, (\d+) keys, [\d.]+ KB/)
    assert.ok(match)
    assert.strictEqual(Number(match[1]), 2)
    assert.ok(Number(match[2]) >= 2)
  })

  it('shows seconds in uptime only when verbose', async () => {
    mock.method(process, 'uptime', () => 11567.9)
    const { ask, sent } = chat(state)
    await ask('status')
    await ask('status verbose')
    assert.match(sent[0]!, /^Uptime: 3h 12m \|/)
    assert.match(sent[1]!, /^Uptime: 3h 12m 47s\n/)
  })

  it('reports uptime alone with the uptime command', async () => {
    const { ask, sent } = chat(state)
    await ask('uptime')
    assert.match(sent[0]!, /^Uptime: \d+[dhms]( \d+[dhms])?$/)
  })

  it('adds discord info only to the verbose status', async () => {
    state.robot.adapter.client = {
      isReady: () => true,
      user: { tag: 'donbot#1234', username: 'donbot' },
      guilds: { cache: { size: 3 } },
      channels: { cache: { size: 12 } },
      users: { cache: { size: 50 } },
      ws: { ping: 42, status: 0 },
      uptime: 11_567_000
    } as unknown as DiscordClient
    const { ask, sent } = chat(state)
    await ask('status')
    assert.doesNotMatch(sent[0]!, /Discord: /)
    await ask('status verbose')
    assert.match(sent[1]!, /Discord: logged in as donbot#1234/)
    assert.match(sent[1]!, /Servers: 3, channels: 12, cached users: 50/)
    assert.match(sent[1]!, /Gateway: Ready, ping 42ms, connected 3h 12m 47s/)
  })

  it('handles a discord client missing optional fields', async () => {
    state.robot.adapter.client = { isReady: () => true }
    const { ask, sent } = chat(state)
    await ask('status verbose')
    assert.match(sent[0]!, /Discord: logged in as unknown/)
    assert.match(sent[0]!, /Servers: unknown, channels: unknown, cached users: unknown/)
    assert.match(sent[0]!, /Gateway: unknown, ping unknown, connected unknown/)
  })
})
