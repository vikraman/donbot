import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { AI_BUSY_RETRY_MS, AI_DAILY_CALLS, AI_POOL_SIZE, AI_QUOTA_RETRY_MS, AI_REFILL_INTERVAL_MS, AI_RETRY_MS, aiCallsToday, bagPick, contextVars, configureLines, defineLines, keptFor, linesIn, poolFor, refillAi, resetLines, scoreLine, validAiLine } from '../scripts/lib/lines.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

// mon 2026-11-16 10:00 utc
const MONDAY_10AM = Date.UTC(2026, 10, 16, 10, 0)

const contextVarsAt = (ms: number) => contextVars('UTC', ms)

const gemini = (lines: unknown) => mock.method(global, 'fetch', async () => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(lines) }] } }] })
}))

describe('lines', () => {
  let originalKey: string | undefined
  beforeEach(() => {
    resetLines()
    configureLines({ extras: false, casual: () => true })
    originalKey = process.env.GEMINI_API_KEY
    delete process.env.GEMINI_API_KEY
  })
  afterEach(() => {
    if (originalKey === undefined) delete process.env.GEMINI_API_KEY
    else process.env.GEMINI_API_KEY = originalKey
    setRandomSource(null)
    mock.reset()
  })

  it('uses every line once before repeating, and never repeats across the reshuffle', () => {
    const items = ['a', 'b', 'c', 'd']
    for (let round = 0; round < 50; round++) {
      const seen = Array.from({ length: 4 }, () => bagPick('t', items))
      assert.deepEqual([...seen].sort(), items)
    }
    const run = Array.from({ length: 400 }, () => bagPick('seam', items))
    run.forEach((item, i) => { if (i) assert.notEqual(item, run[i - 1]) })
  })
  it('starts over when the list changes', () => {
    setRandomSource(() => 0)
    assert.equal(bagPick('change', ['a', 'b']), 'a')
    assert.equal(bagPick('change', ['x', 'y', 'z']), 'x')
  })
  it('fills vars, including daypart and weekday', () => {
    setRandomSource(() => 0)
    mock.method(Date, 'now', () => MONDAY_10AM)
    const line = defineLines('test.fill', { fallback: ['Good {daypart}, {who}! Happy {weekday}.'] })
    assert.equal(line({ who: 'ada' }, { tz: 'UTC' }), 'Good morning, ada! Happy Monday.')
    assert.equal(line({}, { tz: 'UTC' }), 'Good morning, {who}! Happy Monday.')
  })
  it('composes lines from parts', () => {
    setRandomSource(() => 0)
    const line = defineLines('test.parts', { fallback: { open: ['Hey.', ''], body: ['Nice work.', 'Well done.'], close: ['🎉'] } })
    assert.equal(line(), 'Hey. Nice work. 🎉')
    assert.equal(line(), 'Well done. 🎉')
  })
  it('serves rare lines and time-of-week flair only when extras are on', () => {
    setRandomSource(() => 0)
    // monday morning in utc
    mock.method(Date, 'now', () => MONDAY_10AM)
    const line = defineLines('test.rare', { fallback: ['plain'], rare: ['✨ legendary'], flair: true })
    assert.equal(line({}, { tz: 'UTC' }), 'plain')
    configureLines({ extras: true })
    assert.equal(line({}, { tz: 'UTC' }), '✨ legendary Strong start to the week.')
  })
  it('keeps to professional lines where casual ones are off', async () => {
    process.env.GEMINI_API_KEY = 'key'
    gemini(['Fresh, {who}.'])
    setRandomSource(() => 0)
    mock.method(Date, 'now', () => MONDAY_10AM)
    const line = defineLines('test.pro', { fallback: ['Yo {who}, nailed it.'], professional: ['Well done, {who}.'], rare: ['✨ legend'], flair: true, ai: { about: 'x', slots: ['who'] } })
    await refillAi('test.pro')
    configureLines({ extras: true, casual: (room, feature) => room === 'casual' && feature !== 'lines.ratelimit' })
    for (let i = 0; i < 5; i++) assert.equal(line({ who: 'bo' }, { room: 'pro', tz: 'UTC' }), 'Well done, bo.')
    // no room is professional
    assert.equal(line({ who: 'bo' }, { tz: 'UTC' }), 'Well done, bo.')
    assert.equal(line({ who: 'bo' }, { room: 'casual', tz: 'UTC' }), '✨ legend Strong start to the week.')
    // per-kind feature
    const sass = defineLines('test.sass', { fallback: ['Get lost.'], professional: ['Please wait.'], feature: 'lines.ratelimit' })
    assert.equal(sass({}, { room: 'casual' }), 'Please wait.')
    // no pro list: plain lines
    const plain = defineLines('test.plain', { fallback: ['Plain.'], rare: ['✨'] })
    assert.equal(plain({}, { room: 'pro' }), 'Plain.')
  })
  it('validates ai lines', () => {
    assert.equal(validAiLine('Nice one, {who}!', ['who']), true)
    assert.equal(validAiLine('Nice one!', ['who']), false)
    assert.equal(validAiLine('Nice one {who} and {other}', ['who']), false)
    assert.equal(validAiLine('see https://x.y {who}', ['who']), false)
    assert.equal(validAiLine('hey @everyone {who}', ['who']), false)
    assert.equal(validAiLine(`{who} ${'x'.repeat(200)}`, ['who']), false)
    assert.equal(validAiLine(42, []), false)
  })
  it('refills the ai reserve from gemini, keeping only valid, new lines', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const fetch = gemini(['Bravo, {who}.', 'no slot here', 'Bravo, {who}.', 'Take a bow, {who}. 🎭'])
    defineLines('test.ai', { fallback: ['Nice, {who}.'], ai: { about: 'cheers', slots: ['who'] } })
    assert.equal(await refillAi('test.ai'), 2)
    assert.deepEqual(poolFor('test.ai').lines, ['Bravo, {who}.', 'Take a bow, {who}. 🎭'])
    const body = JSON.parse((fetch.mock.calls[0]!.arguments[1] as { body: string }).body)
    assert.match(body.contents[0].parts[0].text, /contain \{who\}/)
    assert.equal(body.generationConfig.responseMimeType, 'application/json')
  })
  it('backs off after a failed refill', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const fetch = mock.method(global, 'fetch', async () => ({ ok: false, status: 500 }))
    defineLines('test.fail', { fallback: ['x'], ai: { about: 'x' } })
    assert.equal(await refillAi('test.fail'), 0)
    assert.equal(await refillAi('test.fail'), 0)
    assert.equal(fetch.mock.callCount(), 1)
  })
  it('mixes ai lines in when extras are on, and tops up when low', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const fetch = gemini(['Fresh one, {who}.'])
    const line = defineLines('test.mix', { fallback: ['Static, {who}.'], ai: { about: 'x', slots: ['who'] } })
    await refillAi('test.mix')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    assert.equal(line({ who: 'bo' }), 'Fresh one, bo.')
    assert.equal(poolFor('test.mix').lines.length, 0)
    await new Promise(resolve => setImmediate(resolve))
    // empty, but refilled less than 6h ago
    assert.equal(fetch.mock.callCount(), 1)
    const start = Date.now()
    mock.method(Date, 'now', () => start + AI_REFILL_INTERVAL_MS + 1)
    line({ who: 'bo' })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(fetch.mock.callCount(), 2)
    configureLines({ casual: (room, feature) => feature !== 'lines.ai' || room !== 'quiet' })
    assert.equal(line({ who: 'bo' }, { room: 'quiet' }), 'Static, bo.')
    assert.ok(AI_POOL_SIZE > 10)
  })
  it('keeps ai lines people love and retires lines people groan at', async () => {
    process.env.GEMINI_API_KEY = 'key'
    gemini(['Loved, {who}.'])
    const line = defineLines('test.score', { fallback: ['Meh, {who}.', 'Fine, {who}.'], ai: { about: 'x', slots: ['who'] } })
    await refillAi('test.score')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    const text = line({ who: 'cy' })
    const [ref] = linesIn(`🎉 ${text} 🔥 streak`)
    assert.deepEqual(ref, { kind: 'test.score', template: 'Loved, {who}.', source: 'ai' })
    scoreLine(ref!, 1)
    scoreLine(ref!, 1)
    assert.deepEqual(keptFor('test.score'), ['Loved, {who}.'])

    configureLines({ extras: false })
    const meh = { kind: 'test.score', template: 'Meh, {who}.', source: 'static' as const }
    scoreLine(meh, -1)
    scoreLine(meh, -1)
    // retired lines are skipped 3 times in 4
    setRandomSource(() => 0)
    const picks = Array.from({ length: 6 }, () => line({ who: 'cy' }))
    assert.ok(!picks.includes('Meh, cy.'))
    assert.ok(picks.includes('Loved, cy.'))

    // no kept ai lines where ai is off
    configureLines({ casual: (_room, feature) => feature !== 'lines.ai' })
    const noAi = Array.from({ length: 6 }, () => line({ who: 'cy' }, { room: 'r' }))
    assert.ok(!noAi.includes('Loved, cy.'))
  })
  it('treats the small hours as the night before', () => {
    // 02:00 monday utc
    const vars = contextVarsAt(Date.UTC(2026, 10, 16, 2, 0))
    assert.deepEqual(vars, { daypart: 'night', weekday: 'Sunday' })
  })
  it('falls back to the lite model when the main one is overloaded', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const urls: string[] = []
    mock.method(global, 'fetch', async (url: string) => {
      urls.push(url)
      if (url.includes('gemini-flash-latest')) return { ok: false, status: 503 }
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '["Lite, {who}."]' }] } }] }) }
    })
    defineLines('test.lite', { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
    assert.equal(await refillAi('test.lite'), 1)
    assert.deepEqual(urls.map(u => u.match(/models\/([\w-]+):/)![1]), ['gemini-flash-latest', 'gemini-flash-lite-latest'])
  })
  it('retries sooner when every model is busy than after other errors', async () => {
    process.env.GEMINI_API_KEY = 'key'
    let status = 503
    const fetch = mock.method(global, 'fetch', async () => ({ ok: false, status }))
    defineLines('test.busy', { fallback: ['x'], ai: { about: 'x' } })
    const start = Date.now()
    const now = mock.method(Date, 'now', () => start)
    await refillAi('test.busy')
    assert.equal(fetch.mock.callCount(), 3)
    now.mock.mockImplementation(() => start + AI_BUSY_RETRY_MS + 1)
    status = 400
    await refillAi('test.busy')
    assert.equal(fetch.mock.callCount(), 4)
    // other errors wait 30m
    now.mock.mockImplementation(() => start + AI_BUSY_RETRY_MS + AI_RETRY_MS)
    await refillAi('test.busy')
    assert.equal(fetch.mock.callCount(), 4)
    status = 429
    now.mock.mockImplementation(() => start + AI_BUSY_RETRY_MS + AI_RETRY_MS + 2)
    await refillAi('test.busy')
    assert.equal(fetch.mock.callCount(), 7)
    // quota errors wait 2h
    now.mock.mockImplementation(() => start + AI_BUSY_RETRY_MS + AI_RETRY_MS + AI_QUOTA_RETRY_MS)
    await refillAi('test.busy')
    assert.equal(fetch.mock.callCount(), 7)
  })
  it('skips unknown models and honours GEMINI_LINE_MODELS', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const original = process.env.GEMINI_LINE_MODELS
    process.env.GEMINI_LINE_MODELS = 'gone-model, good-model'
    const urls: string[] = []
    mock.method(global, 'fetch', async (url: string) => {
      urls.push(url)
      if (url.includes('gone-model')) return { ok: false, status: 404 }
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '["Good, {who}."]' }] } }] }) }
    })
    try {
      defineLines('test.models', { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
      assert.equal(await refillAi('test.models'), 1)
      assert.deepEqual(urls.map(u => u.match(/models\/([\w.-]+):/)![1]), ['gone-model', 'good-model'])
    } finally {
      if (original === undefined) delete process.env.GEMINI_LINE_MODELS
      else process.env.GEMINI_LINE_MODELS = original
    }
  })
  it('stops at the daily request cap, even when forced', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const fetch = gemini(['A, {who}.'])
    const kinds = Array.from({ length: AI_DAILY_CALLS + 3 }, (_, i) => `test.cap${i}`)
    for (const kind of kinds) defineLines(kind, { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
    for (const kind of kinds) await refillAi(kind, { force: true })
    assert.equal(fetch.mock.callCount(), AI_DAILY_CALLS)
    assert.equal(aiCallsToday(), AI_DAILY_CALLS)
  })
  it('runs one refill at a time', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const fetch = gemini(['A, {who}.'])
    defineLines('test.one', { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
    defineLines('test.two', { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
    const [a, b] = await Promise.all([refillAi('test.one'), refillAi('test.two')])
    assert.deepEqual([a, b], [1, 0])
    assert.equal(fetch.mock.callCount(), 1)
  })
  it('moves on when a model times out', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const signals: unknown[] = []
    mock.method(global, 'fetch', async (url: string, init: { signal?: unknown }) => {
      signals.push(init.signal)
      if (url.includes('gemini-flash-latest')) throw new DOMException('timed out', 'TimeoutError')
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: '["Quick, {who}."]' }] } }] }) }
    })
    defineLines('test.slow', { fallback: ['x {who}'], ai: { about: 'x', slots: ['who'] } })
    assert.equal(await refillAi('test.slow'), 1)
    assert.equal(signals.length, 2)
    assert.ok(signals.every(s => s instanceof AbortSignal))
  })
})
