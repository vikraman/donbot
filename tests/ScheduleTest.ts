import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { MAX_ATTEMPTS, RETRY_MS, scheduler } from '../scripts/lib/schedule.ts'
import { setupRobot } from './helpers/setup.ts'
import { runDueJobs, tick } from './helpers/fakes.ts'

describe('scheduler', () => {
  const state = setupRobot([])

  it('fires a one-shot job once and forgets it', async () => {
    const fired: string[] = []
    const s = scheduler<string>(state.robot, 'test', job => { fired.push(job.data) })
    s.add({ at: Date.now() + 20, tz: 'UTC', data: 'hello' })
    assert.strictEqual(s.list().length, 1)
    await tick(60)
    assert.deepStrictEqual(fired, ['hello'])
    assert.strictEqual(s.list().length, 0)
  })
  it('re-arms repeating jobs at the next occurrence', async () => {
    const fired: number[] = []
    const s = scheduler<null>(state.robot, 'test', job => { fired.push(job.at) })
    const start = Date.now()
    const job = s.add({ at: start + 10, tz: 'UTC', repeat: { kind: 'interval', everyMs: 60_000 }, data: null })
    await tick(50)
    assert.strictEqual(fired.length, 1)
    assert.strictEqual(s.get(job.id)!.at, start + 10 + 60_000)
  })
  it('removes jobs before they fire', async () => {
    const fired: string[] = []
    const s = scheduler<string>(state.robot, 'test', job => { fired.push(job.data) })
    const job = s.add({ at: Date.now() + 20, tz: 'UTC', data: 'nope' })
    assert.strictEqual(s.remove(job.id), true)
    assert.strictEqual(s.remove(job.id), false)
    await tick(50)
    assert.deepStrictEqual(fired, [])
  })
  it('retries a failed one-off job a couple of times, then gives up', async () => {
    let calls = 0
    const s = scheduler<null>(state.robot, 'test', () => { calls++; throw new Error('boom') })
    const error = mock.method(state.robot.logger, 'error', () => {})
    s.add({ id: 'x', at: Date.now(), tz: 'UTC', data: null })
    await tick(20)
    assert.strictEqual(error.mock.callCount(), 1)
    const retry = s.get('x')!
    assert.strictEqual(retry.attempts, 1)
    assert.ok(retry.at - Date.now() > RETRY_MS - 1000)
    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      await runDueJobs(state.robot, 'test', 20)
    }
    assert.strictEqual(calls, MAX_ATTEMPTS)
    assert.strictEqual(s.list().length, 0)
  })
  it('does not retry over a follow-up the handler scheduled', async () => {
    const s: ReturnType<typeof scheduler<string>> = scheduler<string>(state.robot, 'test', job => {
      s.add({ id: job.id, at: Date.now() + 60_000, tz: 'UTC', data: 'next' })
      throw new Error('send failed')
    })
    mock.method(state.robot.logger, 'error', () => {})
    s.add({ id: 'x', at: Date.now(), tz: 'UTC', data: 'first' })
    await tick(20)
    assert.deepStrictEqual(s.list().map(j => [j.data, j.attempts]), [['next', undefined]])
  })
  it('fires repeats missed within the grace once, and lets a script tidy ones it skips', async () => {
    const now = Date.now()
    state.robot.brain.set('schedule:test', [
      { id: 'recent', at: now - 3 * 3_600_000, tz: 'UTC', repeat: { kind: 'interval', everyMs: 7 * 86_400_000 }, data: { skip: false } },
      { id: 'old', at: now - 3 * 86_400_000, tz: 'UTC', repeat: { kind: 'interval', everyMs: 7 * 86_400_000 }, data: { skip: true } }
    ])
    const fired: string[] = []
    const s = scheduler<{ skip: boolean }>(state.robot, 'test', job => { fired.push(job.id) }, {
      missedGraceMs: 86_400_000,
      onMissed: job => ({ ...job, data: { skip: false } })
    })
    state.robot.brain.emit('connected')
    await tick(30)
    assert.deepStrictEqual(fired, ['recent'])
    assert.deepStrictEqual(s.get('old')!.data, { skip: false })
    assert.ok(s.get('old')!.at > now)
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
    assert.deepStrictEqual(fired, ['late'])
    assert.ok(s.get('stale')!.at > now)
  })
})
