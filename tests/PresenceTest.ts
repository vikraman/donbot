import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'


import { setupRobot } from './helpers/setup.ts'

describe('Presence', () => {
  const state = setupRobot('Presence.ts', { deferLoad: true })

  // fake client, then load; returns the setActivity mock
  const load = async (client: Record<string, unknown> = {}) => {
    const setActivity = mock.fn()
    state.robot.adapter.client = { isReady: () => true, user: { setActivity }, ...client }
    await state.loadScript()
    return setActivity
  }

  // distinct statuses over n rotations
  const sample = (setActivity: ReturnType<typeof mock.fn>, n = 200) => {
    const statuses = new Set<string>()
    for (let i = 0; i < n; i++) {
      state.robot.brain.emit('connected')
      statuses.add(setActivity.mock.calls.at(-1)!.arguments[0] as string)
    }
    return [...statuses]
  }

  it('loads without a discord client', async () => {
    await state.loadScript()
    assert.doesNotThrow(() => state.robot.brain.emit('connected'))
  })

  it('sets a custom activity once connected', async () => {
    const setActivity = await load()
    state.robot.brain.emit('connected')
    assert.strictEqual(setActivity.mock.calls.length, 1)
    const [text, options] = setActivity.mock.calls[0]!.arguments as [string, { type: number }]
    assert.ok(text.length > 0)
    assert.strictEqual(options.type, 4)
  })

  it('waits until the client is ready', async () => {
    const setActivity = await load({ isReady: () => false })
    state.robot.brain.emit('connected')
    assert.strictEqual(setActivity.mock.calls.length, 0)
  })

  it('keeps one rotation timer across brain reconnects', async () => {
    // only presence's intervals
    const live = new Set<object>()
    const realSet = global.setInterval
    const realClear = global.clearInterval
    mock.method(global, 'setInterval', (fn: () => void, ms: number) => {
      if (ms !== 15 * 60 * 1000) return realSet(fn, ms)
      const handle = { unref: () => handle }
      live.add(handle)
      return handle
    })
    mock.method(global, 'clearInterval', (handle: unknown) => {
      if (live.delete(handle as object)) return
      realClear(handle as NodeJS.Timeout)
    })
    await load()
    for (let i = 0; i < 3; i++) state.robot.brain.emit('connected')
    assert.strictEqual(live.size, 1)
  })

  it('rotates through its statuses', async () => {
    state.robot.brain.set('seen:last', Date.now() - 5 * 60000)
    const statuses = sample(await load({ guilds: { cache: { size: 3 } } }))
    for (const [name, pattern] of [
      ['servers', /^In 3 servers$/],
      ['tricks', /^Knows \d+ tricks?$/],
      ['memory', /^Using [\d.]+MB$/],
      ['brain', /^Brain: [\d.]+ KB$/],
      ['quiet', /^Quiet for \d+m$/],
      ['date', /^Today: /],
      ['mood', /^\p{Emoji}.{0,2}$/u]
    ] as const) assert.ok(statuses.some(s => pattern.test(s)), name)
  })

  it('reports who is focusing, leaving out breaks', async () => {
    const setActivity = await load()
    const focus = (...jobs: unknown[]) => { state.robot.brain.set('schedule:focus', jobs); return sample(setActivity, 300) }
    const work = { id: 'a', data: { phase: 'work' } }
    const tock = { id: 'b', data: { phase: 'work', cycle: { tock: true } } }
    const rest = { id: 'c', data: { phase: 'break' } }
    assert.ok(focus(work, tock, rest).includes('2 people focusing 🤫'))
    assert.ok(focus(tock).includes('1 person on a tock 🕰️'))
    assert.ok(!focus(rest).some(s => /focusing|tock/.test(s)))
  })
})
