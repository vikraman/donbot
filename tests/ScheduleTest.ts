import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { scheduler } from '../scripts/lib/schedule.ts'
import { setupRobot } from './helpers/setup.ts'

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('scheduler', () => {
  const state = setupRobot([])

  it('fires a one-shot job once and forgets it', async () => {
    const fired: string[] = []
    const s = scheduler<string>(state.robot, 'test', job => { fired.push(job.data) })
    s.add({ at: Date.now() + 20, tz: 'UTC', data: 'hello' })
    assert.equal(s.list().length, 1)
    await tick(60)
    assert.deepEqual(fired, ['hello'])
    assert.equal(s.list().length, 0)
  })
  it('re-arms repeating jobs at the next occurrence', async () => {
    const fired: number[] = []
    const s = scheduler<null>(state.robot, 'test', job => { fired.push(job.at) })
    const start = Date.now()
    const job = s.add({ at: start + 10, tz: 'UTC', repeat: { kind: 'interval', everyMs: 60_000 }, data: null })
    await tick(50)
    assert.equal(fired.length, 1)
    assert.equal(s.get(job.id)!.at, start + 10 + 60_000)
  })
  it('removes jobs before they fire', async () => {
    const fired: string[] = []
    const s = scheduler<string>(state.robot, 'test', job => { fired.push(job.data) })
    const job = s.add({ at: Date.now() + 20, tz: 'UTC', data: 'nope' })
    assert.equal(s.remove(job.id), true)
    assert.equal(s.remove(job.id), false)
    await tick(50)
    assert.deepEqual(fired, [])
  })
  it('keeps going after a handler throws', async () => {
    const s = scheduler<null>(state.robot, 'test', () => { throw new Error('boom') })
    const error = mock.method(state.robot.logger, 'error', () => {})
    s.add({ at: Date.now(), tz: 'UTC', data: null })
    await tick(20)
    assert.equal(error.mock.callCount(), 1)
    assert.equal(s.list().length, 0)
  })
  it('re-arms stored jobs on brain connect, skipping long-missed repeats', async () => {
    const now = Date.now()
    state.robot.brain.set('schedule:test', [
      { id: 'late', at: now - 1000, tz: 'UTC', data: 'late' },
      { id: 'stale', at: now - 3 * 3_600_000, tz: 'UTC', repeat: { kind: 'interval', everyMs: 3_600_000 }, data: 'stale' }
    ])
    const fired: string[] = []
    const s = scheduler<string>(state.robot, 'test', job => { fired.push(job.data) })
    state.robot.brain.emit('connected')
    await tick(30)
    assert.deepEqual(fired, ['late'])
    assert.ok(s.get('stale')!.at > now)
  })
})
