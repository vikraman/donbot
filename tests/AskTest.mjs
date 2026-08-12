import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

const geminiResponse = text => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] })
})

const wikiSearchResult = title => ({
  json: async () => ({ query: { search: [{ title }] } })
})

describe('Ask testing Hubot scripts', () => {
  let robot = null
  let originalGeminiKey
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    originalGeminiKey = process.env.GEMINI_API_KEY
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Ask.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    if (originalGeminiKey === undefined) {
      delete process.env.GEMINI_API_KEY
    } else {
      process.env.GEMINI_API_KEY = originalGeminiKey
    }
    robot.shutdown()
    mock.reset()
  })

  it('should answer via gemini first when a key is configured', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => geminiResponse('Paris is the capital of France.'))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask capital of france', 'test-room')
    assert.strictEqual(sent[0], 'Paris is the capital of France.')
  })

  it('should fall back to duckduckgo when gemini has no key', async () => {
    delete process.env.GEMINI_API_KEY
    mock.method(global, 'fetch', async () => ({
      json: async () => ({ AbstractText: '', Answer: '42', Definition: '' })
    }))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask what is 6 times 7', 'test-room')
    assert.strictEqual(sent[0], '42')
  })

  it('should fall back to wikipedia when gemini and duckduckgo have no answer', async () => {
    delete process.env.GEMINI_API_KEY
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('duckduckgo')) {
        return { json: async () => ({ AbstractText: '', Answer: '', Definition: '' }) }
      }
      if (url.includes('list=search')) {
        return wikiSearchResult('Ada Lovelace')
      }
      return { ok: true, json: async () => ({ extract: 'Ada Lovelace was an English mathematician.' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask who is ada lovelace', 'test-room')
    assert.strictEqual(sent[0], 'Ada Lovelace was an English mathematician.')
  })

  it('should resolve a natural-language question with trailing punctuation', async () => {
    delete process.env.GEMINI_API_KEY
    let wikiSearchUrl = ''
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('duckduckgo')) {
        return { json: async () => ({ AbstractText: '', Answer: '', Definition: '' }) }
      }
      if (url.includes('list=search')) {
        wikiSearchUrl = url
        return wikiSearchResult('List of capitals of France')
      }
      return { ok: true, json: async () => ({ extract: 'Paris has been the capital of France since its liberation in 1944.' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask what is the capital of France?', 'test-room')
    assert.match(decodeURIComponent(wikiSearchUrl), /srsearch=capital of France(?!\?)/)
    assert.strictEqual(sent[0], 'Paris has been the capital of France since its liberation in 1944.')
  })

  it('should say it has no answer when every source comes up empty', async () => {
    delete process.env.GEMINI_API_KEY
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('duckduckgo')) {
        return { json: async () => ({ AbstractText: '', Answer: '', Definition: '' }) }
      }
      return { json: async () => ({ query: { search: [] } }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask asdkjaslkdj', 'test-room')
    assert.strictEqual(sent[0], "I don't have an answer for that.")
  })

  it('should support "please ask" as an alternate phrasing', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => geminiResponse('Polite answer.'))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant please ask what is rust', 'test-room')
    assert.strictEqual(sent[0], 'Polite answer.')
  })

  it('should support "tell me about" as an alternate phrasing', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => geminiResponse('Rust is a systems programming language.'))
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant tell me about rust', 'test-room')
    assert.strictEqual(sent[0], 'Rust is a systems programming language.')
  })

  it('should query gemini directly with "ask gg"', async () => {
    process.env.GEMINI_API_KEY = 'test-key'
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return geminiResponse('Direct gemini answer.')
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask gg what is rust', 'test-room')
    assert.match(requestedUrl, /generativelanguage\.googleapis\.com/)
    assert.strictEqual(sent[0], 'Direct gemini answer.')
  })

  it('should query duckduckgo directly with "ask ddg"', async () => {
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { json: async () => ({ AbstractText: 'Direct ddg answer.', Answer: '', Definition: '' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask ddg rust programming language', 'test-room')
    assert.match(requestedUrl, /duckduckgo\.com/)
    assert.strictEqual(sent[0], 'Direct ddg answer.')
  })

  it('should query wikipedia directly with "ask wiki"', async () => {
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('list=search')) {
        return wikiSearchResult('Rust (programming language)')
      }
      return { ok: true, json: async () => ({ extract: 'Direct wiki answer.' }) }
    })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant ask wiki rust programming language', 'test-room')
    assert.strictEqual(sent[0], 'Direct wiki answer.')
  })
})
