import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.mjs'

const geminiResponse = text => ({
  ok: true,
  json: async () => ({ candidates: [{ content: { parts: [{ text }] } }] })
})

const wikiSearchResult = title => ({
  json: async () => ({ query: { search: [{ title }] } })
})

describe('Ask testing Hubot scripts', () => {
  const state = setupRobot('Ask.mjs', { envVars: ['GEMINI_API_KEY'] })

  it('should answer via gemini first when a key is configured', async () => {
    const { robot } = state
    process.env.GEMINI_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => geminiResponse('Paris is the capital of France.'))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask capital of france', 'test-room')
    assert.strictEqual(sent[0], 'Paris is the capital of France. [Gemini]')
  })

  it('should fall back to duckduckgo when gemini has no key', async () => {
    const { robot } = state
    delete process.env.GEMINI_API_KEY
    mock.method(global, 'fetch', async () => ({
      json: async () => ({ AbstractText: '', Answer: '42', Definition: '' })
    }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask what is 6 times 7', 'test-room')
    assert.strictEqual(sent[0], '42 [DuckDuckGo]')
  })

  it('should fall back to wikipedia when gemini and duckduckgo have no answer', async () => {
    const { robot } = state
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
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask who is ada lovelace', 'test-room')
    assert.strictEqual(sent[0], 'Ada Lovelace was an English mathematician. [Wikipedia]')
  })

  it('should resolve a natural-language question with trailing punctuation', async () => {
    const { robot } = state
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
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask what is the capital of France?', 'test-room')
    assert.match(decodeURIComponent(wikiSearchUrl), /srsearch=capital of France(?!\?)/)
    assert.strictEqual(sent[0], 'Paris has been the capital of France since its liberation in 1944. [Wikipedia]')
  })

  it('should resolve a contracted question like "what\'s" without garbling the search', async () => {
    const { robot } = state
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
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, "@Dumbotheelephant ask what's the capital of France?", 'test-room')
    assert.match(decodeURIComponent(wikiSearchUrl), /srsearch=capital of France(?!\?)/)
    assert.strictEqual(sent[0], 'Paris has been the capital of France since its liberation in 1944. [Wikipedia]')
  })

  it('should not swallow "does" when stripping "how does"', async () => {
    const { robot } = state
    delete process.env.GEMINI_API_KEY
    let wikiSearchUrl = ''
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('duckduckgo')) {
        return { json: async () => ({ AbstractText: '', Answer: '', Definition: '' }) }
      }
      if (url.includes('list=search')) {
        wikiSearchUrl = url
        return wikiSearchResult('Photosynthesis')
      }
      return { ok: true, json: async () => ({ extract: 'Photosynthesis is a system of biological processes.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask how does photosynthesis work', 'test-room')
    assert.match(decodeURIComponent(wikiSearchUrl), /srsearch=photosynthesis work&/)
  })

  it('should send gemini the raw, unstripped question', async () => {
    const { robot } = state
    process.env.GEMINI_API_KEY = 'test-key'
    let requestBody = null
    mock.method(global, 'fetch', async (url, options) => {
      requestBody = JSON.parse(options.body)
      return geminiResponse('Paris.')
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, "@Dumbotheelephant ask what's the capital of France?", 'test-room')
    assert.strictEqual(requestBody.contents[0].parts[0].text, "what's the capital of France?")
  })

  it('should request a large enough token budget to survive thinking overhead', async () => {
    const { robot } = state
    process.env.GEMINI_API_KEY = 'test-key'
    let requestBody = null
    mock.method(global, 'fetch', async (url, options) => {
      requestBody = JSON.parse(options.body)
      return geminiResponse('Answer.')
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask years of Napoleon\'s rule?', 'test-room')
    assert.ok(requestBody.generationConfig.maxOutputTokens >= 1000)
    assert.match(requestBody.systemInstruction.parts[0].text, /short/i)
  })

  it('should say it has no answer when every source comes up empty', async () => {
    const { robot } = state
    delete process.env.GEMINI_API_KEY
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('duckduckgo')) {
        return { json: async () => ({ AbstractText: '', Answer: '', Definition: '' }) }
      }
      return { json: async () => ({ query: { search: [] } }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask asdkjaslkdj', 'test-room')
    assert.strictEqual(sent[0], "I don't have an answer for that.")
  })

  it('should support "please ask" as an alternate phrasing', async () => {
    const { robot } = state
    process.env.GEMINI_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => geminiResponse('Polite answer.'))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant please ask what is rust', 'test-room')
    assert.strictEqual(sent[0], 'Polite answer. [Gemini]')
  })

  it('should support "tell me about" as an alternate phrasing', async () => {
    const { robot } = state
    process.env.GEMINI_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => geminiResponse('Rust is a systems programming language.'))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant tell me about rust', 'test-room')
    assert.strictEqual(sent[0], 'Rust is a systems programming language. [Gemini]')
  })

  it('should query gemini directly with "ask gg"', async () => {
    const { robot } = state
    process.env.GEMINI_API_KEY = 'test-key'
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return geminiResponse('Direct gemini answer.')
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask gg what is rust', 'test-room')
    assert.match(requestedUrl, /generativelanguage\.googleapis\.com/)
    assert.strictEqual(sent[0], 'Direct gemini answer. [Gemini]')
    assert.strictEqual(sent.length, 1)
  })

  it('should query duckduckgo directly with "ask ddg"', async () => {
    const { robot } = state
    let requestedUrl = ''
    mock.method(global, 'fetch', async (url) => {
      requestedUrl = url
      return { json: async () => ({ AbstractText: 'Direct ddg answer.', Answer: '', Definition: '' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask ddg rust programming language', 'test-room')
    assert.match(requestedUrl, /duckduckgo\.com/)
    assert.strictEqual(sent[0], 'Direct ddg answer. [DuckDuckGo]')
    assert.strictEqual(sent.length, 1)
  })

  it('should not also fire the fallback-chain listener when using "ask ddg" and ddg has no answer', async () => {
    const { robot } = state
    delete process.env.GEMINI_API_KEY
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('duckduckgo')) {
        return { json: async () => ({ AbstractText: '', Answer: '', Definition: '' }) }
      }
      return { json: async () => ({ query: { search: [] } }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask ddg rust programming language', 'test-room')
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0], "I don't have an answer for that.")
  })

  it('should query wikipedia directly with "ask wiki"', async () => {
    const { robot } = state
    mock.method(global, 'fetch', async (url) => {
      if (url.includes('list=search')) {
        return wikiSearchResult('Rust (programming language)')
      }
      return { ok: true, json: async () => ({ extract: 'Direct wiki answer.' }) }
    })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask wiki rust programming language', 'test-room')
    assert.strictEqual(sent[0], 'Direct wiki answer. [Wikipedia]')
    assert.strictEqual(sent.length, 1)
  })
})
