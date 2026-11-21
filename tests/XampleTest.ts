import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { setupRobot, chat, collect, collectRooms } from './helpers/setup.ts'

const HELO = "HELO World! I'm Dumbotheelephant."

describe('Xample', () => {
  const state = setupRobot('Xample.ts')

  it('serves /helo', async () => {
    const { port } = state.robot.server!.address() as AddressInfo
    const response = await fetch(`http://localhost:${port}/helo`)
    assert.strictEqual(await response.text(), HELO)
  })

  it('replies to helo', async () => {
    const { robot, ask } = chat(state)
    const replies = collect(robot, 'reply')
    await ask('helo')
    assert.deepStrictEqual(replies, [HELO])
  })

  it('sends to the room it was asked in', async () => {
    const { robot, ask } = chat(state, { room: 'general' })
    const sent = collectRooms(robot)
    await ask('helo room')
    assert.strictEqual(sent[0]?.room, 'general')
  })
})
