import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordClient } from 'hubot'

import { postToRoom } from '../scripts/lib/rooms.ts'
import { setupRobot } from './helpers/setup.ts'

describe('postToRoom', () => {
  const state = setupRobot([])

  it('fetches an uncached channel, like a dm after a restart, before sending', async () => {
    const { robot } = state
    const cache = new Map<string, unknown>()
    const fetch = mock.fn(async (id: string) => { cache.set(id, {}); return {} })
    robot.adapter.client = { channels: { cache, fetch } } as unknown as DiscordClient
    const send = mock.method(robot, 'messageRoom', async () => {})
    await postToRoom(robot, 'dm-1', 'hello')
    assert.equal(fetch.mock.callCount(), 1)
    assert.ok(cache.has('dm-1'))
    assert.deepEqual(send.mock.calls[0]!.arguments, ['dm-1', 'hello'])
    await postToRoom(robot, 'dm-1', 'again')
    assert.equal(fetch.mock.callCount(), 1)
  })
  it('still tries to send when the fetch fails', async () => {
    const { robot } = state
    robot.adapter.client = { channels: { cache: new Map(), fetch: async () => { throw new Error('Unknown Channel') } } } as unknown as DiscordClient
    mock.method(robot.logger, 'warn', () => {})
    const send = mock.method(robot, 'messageRoom', async () => {})
    await postToRoom(robot, 'gone', 'hi')
    assert.equal(send.mock.callCount(), 1)
  })
})
