import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { AI_BUSY_RETRY_MS, AI_DAILY_CALLS, AI_POOL_SIZE, AI_QUOTA_RETRY_MS, AI_REFILL_INTERVAL_MS, AI_RETRY_MS, aiCallsToday, bagPick, contextVars, configureLines, defineLines, keptFor, linesIn, poolFor, refillAi, resetLines, scoreLine, validAiLine } from '../scripts/lib/lines.ts'
import { setRandomSource } from '../scripts/lib/random.ts'
import { clock, geminiBody, mockFetch, mockGemini, settle, withEnv } from './helpers/fakes.ts'
import { fc } from './helpers/arb.ts'

// mon 2026-11-16 10:00 utc
const MONDAY_10AM = Date.UTC(2026, 10, 16, 10, 0)

const contextVarsAt = (ms: number) => contextVars('UTC', ms)

const AI = { about: 'x', slots: ['who'] }

// fetch replying with an http status, no body
const failFetch = (status: () => number) => {
  const urls: string[] = []
  mock.method(globalThis, 'fetch', async (url: string) => { urls.push(url); return { ok: false, status: status() } })
  return urls
}

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

  it('uses every line once per cycle, never repeating across the reshuffle', () => {
    let n = 0
    const lists = fc.uniqueArray(fc.string({ minLength: 1, maxLength: 3 }), { minLength: 2, maxLength: 8 })
    fc.assert(fc.property(lists, fc.integer({ min: 1, max: 6 }), (items, cycles) => {
      const key = `bag${n++}`
      const run = Array.from({ length: items.length * cycles }, () => bagPick(key, items)!)
      for (let c = 0; c < cycles; c++) assert.deepStrictEqual(run.slice(c * items.length, (c + 1) * items.length).sort(), [...items].sort())
      run.forEach((item, i) => { if (i) assert.notStrictEqual(item, run[i - 1]) })
    }))
  })
  it('starts over when the list changes', () => {
    setRandomSource(() => 0)
    assert.strictEqual(bagPick('change', ['a', 'b']), 'a')
    assert.strictEqual(bagPick('change', ['x', 'y', 'z']), 'x')
  })
  it('fills vars, including daypart and weekday', () => {
    setRandomSource(() => 0)
    clock(MONDAY_10AM)
    const line = defineLines('test.fill', { fallback: ['Good {daypart}, {who}! Happy {weekday}.'] })
    assert.strictEqual(line({ who: 'ada' }, { tz: 'UTC' }), 'Good morning, ada! Happy Monday.')
    assert.strictEqual(line({}, { tz: 'UTC' }), 'Good morning, {who}! Happy Monday.')
  })
  it('composes lines from parts', () => {
    setRandomSource(() => 0)
    const line = defineLines('test.parts', { fallback: { open: ['Hey.', ''], body: ['Nice work.', 'Well done.'], close: ['🎉'] } })
    assert.strictEqual(line(), 'Hey. Nice work. 🎉')
    assert.strictEqual(line(), 'Well done. 🎉')
  })
  it('serves rare lines and time-of-week flair only when extras are on', () => {
    setRandomSource(() => 0)
    clock(MONDAY_10AM)
    const line = defineLines('test.rare', { fallback: ['plain'], rare: ['✨ legendary'], flair: true })
    assert.strictEqual(line({}, { tz: 'UTC' }), 'plain')
    configureLines({ extras: true })
    assert.strictEqual(line({}, { tz: 'UTC' }), '✨ legendary Strong start to the week.')
  })
  it('keeps to professional lines where casual ones are off', async () => {
    process.env.GEMINI_API_KEY = 'key'
    mockGemini(['Fresh, {who}.'])
    setRandomSource(() => 0)
    clock(MONDAY_10AM)
    const line = defineLines('test.pro', { fallback: ['Yo {who}, nailed it.'], professional: ['Well done, {who}.'], rare: ['✨ legend'], flair: true, ai: AI })
    await refillAi('test.pro')
    configureLines({ extras: true, casual: (room, feature) => room === 'casual' && feature !== 'lines.ratelimit' })
    for (let i = 0; i < 5; i++) assert.strictEqual(line({ who: 'bo' }, { room: 'pro', tz: 'UTC' }), 'Well done, bo.')
    // no room is professional
    assert.strictEqual(line({ who: 'bo' }, { tz: 'UTC' }), 'Well done, bo.')
    assert.strictEqual(line({ who: 'bo' }, { room: 'casual', tz: 'UTC' }), '✨ legend Strong start to the week.')
    // per-kind feature
    const sass = defineLines('test.sass', { fallback: ['Get lost.'], professional: ['Please wait.'], feature: 'lines.ratelimit' })
    assert.strictEqual(sass({}, { room: 'casual' }), 'Please wait.')
    // no pro list: plain lines
    const plain = defineLines('test.plain', { fallback: ['Plain.'], rare: ['✨'] })
    assert.strictEqual(plain({}, { room: 'pro' }), 'Plain.')
  })
  it('validates ai lines', () => {
    assert.strictEqual(validAiLine('Nice one, {who}!', ['who']), true)
    assert.strictEqual(validAiLine('Nice one!', ['who']), false)
    assert.strictEqual(validAiLine('Nice one {who} and {other}', ['who']), false)
    assert.strictEqual(validAiLine('see https://x.y {who}', ['who']), false)
    assert.strictEqual(validAiLine('hey @everyone {who}', ['who']), false)
    assert.strictEqual(validAiLine(`{who} ${'x'.repeat(200)}`, ['who']), false)
    assert.strictEqual(validAiLine(42, []), false)
  })
  it('refills the ai reserve from gemini, keeping only valid, new lines', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const bodies: { contents: { parts: { text: string }[] }[], generationConfig: { responseMimeType: string } }[] = []
    mockFetch((_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(init?.body as string) as (typeof bodies)[number])
      return geminiBody(['Bravo, {who}.', 'no slot here', 'Bravo, {who}.', 'Take a bow, {who}. 🎭'])
    })
    defineLines('test.ai', { fallback: ['Nice, {who}.'], ai: { about: 'cheers', slots: ['who'] } })
    assert.strictEqual(await refillAi('test.ai'), 2)
    assert.deepStrictEqual(poolFor('test.ai').lines, ['Bravo, {who}.', 'Take a bow, {who}. 🎭'])
    assert.match(bodies[0]!.contents[0]!.parts[0]!.text, /contain \{who\}/)
    assert.strictEqual(bodies[0]!.generationConfig.responseMimeType, 'application/json')
  })
  it('backs off after a failed refill', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const urls = failFetch(() => 500)
    defineLines('test.fail', { fallback: ['x'], ai: { about: 'x' } })
    assert.strictEqual(await refillAi('test.fail'), 0)
    assert.strictEqual(await refillAi('test.fail'), 0)
    assert.strictEqual(urls.length, 1)
  })
  it('mixes ai lines in when extras are on, and tops up when low', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const urls = mockGemini(['Fresh one, {who}.'])
    const line = defineLines('test.mix', { fallback: ['Static, {who}.'], ai: AI })
    await refillAi('test.mix')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    assert.strictEqual(line({ who: 'bo' }), 'Fresh one, bo.')
    assert.strictEqual(poolFor('test.mix').lines.length, 0)
    await settle()
    // empty, but refilled less than 6h ago
    assert.strictEqual(urls.length, 1)
    clock().advance(AI_REFILL_INTERVAL_MS + 1)
    line({ who: 'bo' })
    await settle()
    assert.strictEqual(urls.length, 2)
    configureLines({ casual: (room, feature) => feature !== 'lines.ai' || room !== 'quiet' })
    assert.strictEqual(line({ who: 'bo' }, { room: 'quiet' }), 'Static, bo.')
    assert.ok(AI_POOL_SIZE > 10)
  })
  it('keeps ai lines people love and retires lines people groan at', async () => {
    process.env.GEMINI_API_KEY = 'key'
    mockGemini(['Loved, {who}.'])
    const line = defineLines('test.score', { fallback: ['Meh, {who}.', 'Fine, {who}.'], ai: AI })
    await refillAi('test.score')
    configureLines({ extras: true })
    setRandomSource(() => 0)
    const text = line({ who: 'cy' })
    const [ref] = linesIn(`🎉 ${text} 🔥 streak`)
    assert.deepStrictEqual(ref, { kind: 'test.score', template: 'Loved, {who}.', source: 'ai' })
    scoreLine(ref, 1)
    scoreLine(ref, 1)
    assert.deepStrictEqual(keptFor('test.score'), ['Loved, {who}.'])

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
    assert.deepStrictEqual(vars, { daypart: 'night', weekday: 'Sunday' })
  })
  for (const [name, models, fail, expected] of [
    ['falls back to the lite model when the main one is overloaded', undefined, () => ({ ok: false, status: 503 }), ['gemini-flash-latest', 'gemini-flash-lite-latest']],
    ['skips unknown models from GEMINI_LINE_MODELS', 'gone-model, good-model', () => ({ ok: false, status: 404 }), ['gone-model', 'good-model']],
    ['moves on when a model times out', undefined, () => { throw new DOMException('timed out', 'TimeoutError') }, ['gemini-flash-latest', 'gemini-flash-lite-latest']]
  ] as const) {
    it(name, async () => {
      process.env.GEMINI_API_KEY = 'key'
      const calls: { model: string, signal: unknown }[] = []
      mock.method(globalThis, 'fetch', async (url: string, init: { signal?: unknown }) => {
        const model = url.match(/models\/([\w.-]+):/)![1]!
        calls.push({ model, signal: init.signal })
        if (model === expected[0]) return fail()
        return { ok: true, status: 200, json: async () => geminiBody(['Ok, {who}.']) }
      })
      await withEnv({ GEMINI_LINE_MODELS: models }, async () => {
        defineLines(`test.${name}`, { fallback: ['x {who}'], ai: AI })
        assert.strictEqual(await refillAi(`test.${name}`), 1)
      })
      assert.deepStrictEqual(calls.map(c => c.model), expected)
      assert.ok(calls.every(c => c.signal instanceof AbortSignal))
    })
  }
  it('retries sooner when every model is busy than after other errors', async () => {
    process.env.GEMINI_API_KEY = 'key'
    let status = 503
    const urls = failFetch(() => status)
    defineLines('test.busy', { fallback: ['x'], ai: { about: 'x' } })
    const t = clock()
    // [advance, status, total calls]
    for (const [ms, code, calls] of [
      [0, 503, 3],
      [AI_BUSY_RETRY_MS + 1, 400, 4],
      // other errors wait 30m
      [AI_RETRY_MS - 1, 400, 4],
      [2, 429, 7],
      // quota errors wait 2h
      [AI_QUOTA_RETRY_MS - 2, 429, 7]
    ]) {
      t.advance(ms!)
      status = code!
      await refillAi('test.busy')
      assert.strictEqual(urls.length, calls)
    }
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
      assert.strictEqual(await refillAi('test.models'), 1)
      assert.deepStrictEqual(urls.map(u => u.match(/models\/([\w.-]+):/)![1]), ['gone-model', 'good-model'])
    } finally {
      if (original === undefined) delete process.env.GEMINI_LINE_MODELS
      else process.env.GEMINI_LINE_MODELS = original
    }
  })
  it('stops at the daily request cap, even when forced', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const urls = mockGemini(['A, {who}.'])
    const kinds = Array.from({ length: AI_DAILY_CALLS + 3 }, (_, i) => `test.cap${i}`)
    for (const kind of kinds) defineLines(kind, { fallback: ['x {who}'], ai: AI })
    for (const kind of kinds) await refillAi(kind, { force: true })
    assert.strictEqual(urls.length, AI_DAILY_CALLS)
    assert.strictEqual(aiCallsToday(), AI_DAILY_CALLS)
  })
  it('runs one refill at a time', async () => {
    process.env.GEMINI_API_KEY = 'key'
    const urls = mockGemini(['A, {who}.'])
    defineLines('test.one', { fallback: ['x {who}'], ai: AI })
    defineLines('test.two', { fallback: ['x {who}'], ai: AI })
    const [a, b] = await Promise.all([refillAi('test.one'), refillAi('test.two')])
    assert.deepStrictEqual([a, b], [1, 0])
    assert.strictEqual(urls.length, 1)
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
    assert.strictEqual(await refillAi('test.slow'), 1)
    assert.strictEqual(signals.length, 2)
    assert.ok(signals.every(s => s instanceof AbortSignal))
  })
})
