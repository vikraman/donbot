import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'

import { setRandomSource } from '../scripts/lib/random.ts'

const hit = () => setRandomSource(() => 0)
const miss = () => setRandomSource(c => Math.floor(0.999 * c))

describe('Killit', () => {
  const state = setupRobot('Killit.ts')

  it('jokes when the roll succeeds', async () => {
    hit()
    const { sent, say } = chat(state)
    await say('kill the process')
    assert.deepStrictEqual(sent, ['Kill it, kill it with fire!'])
  })

  it('stays quiet on a failed roll without starting the cooldown', async () => {
    const { sent, say } = chat(state)
    miss()
    await say('kill the process')
    assert.deepStrictEqual(sent, [])
    hit()
    await say('kill the process')
    assert.strictEqual(sent.length, 1)
  })

  it('cools down per room', async () => {
    hit()
    const { sent, say } = chat(state)
    await say('kill the process', { room: 'room-1' })
    await say('kill the process', { room: 'room-1' })
    await say('kill the process', { room: 'room-2' })
    assert.strictEqual(sent.length, 2)
  })
})
