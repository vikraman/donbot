import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'
import { geminiBody, mockFetch } from './helpers/fakes.ts'

interface GeminiRequest {
  contents: { parts: { text: string }[] }[]
  systemInstruction: { parts: { text: string }[] }
  generationConfig: { maxOutputTokens: number }
}

interface Sources {
  gemini?: string
  ddg?: string
  wiki?: [title: string, extract: string]
}

const EMPTY_DDG = { AbstractText: '', Answer: '', Definition: '' }

// routes fetch by host; returns urls and request bodies
const sources = ({ gemini, ddg = '', wiki }: Sources) => {
  const bodies: GeminiRequest[] = []
  const urls = mockFetch((url: string, init?: RequestInit) => {
    if (url.includes('generativelanguage')) {
      bodies.push(JSON.parse(init?.body as string) as GeminiRequest)
      return geminiBody(gemini ?? '')
    }
    if (url.includes('duckduckgo')) return { ...EMPTY_DDG, Answer: ddg }
    if (url.includes('list=search')) return { query: { search: wiki ? [{ title: wiki[0] }] : [] } }
    return { extract: wiki?.[1] }
  })
  return { urls, bodies }
}

const wikiSearch = (urls: string[]) => decodeURIComponent(urls.find(u => u.includes('list=search')) ?? '')

describe('Ask', () => {
  const state = setupRobot('Ask.ts', { envVars: ['GEMINI_API_KEY'] })
  const withKey = () => { process.env.GEMINI_API_KEY = 'test-key' }
  const noKey = () => { delete process.env.GEMINI_API_KEY }

  for (const phrase of ['ask capital of france', 'please ask capital of france', 'tell me about france']) {
    it(`answers "${phrase}" via gemini first`, async () => {
      withKey()
      sources({ gemini: 'Paris.' })
      const { sent, ask } = chat(state)
      await ask(phrase)
      assert.deepStrictEqual(sent, ['Paris. [Gemini]'])
    })
  }

  it('falls back to duckduckgo, then wikipedia, then gives up', async () => {
    noKey()
    const { sent, ask } = chat(state)
    sources({ ddg: '42' })
    await ask('ask what is 6 times 7')
    mock.reset()
    sources({ wiki: ['Ada Lovelace', 'Ada Lovelace was an English mathematician.'] })
    await ask('ask who is ada lovelace')
    mock.reset()
    sources({})
    await ask('ask asdkjaslkdj')
    assert.deepStrictEqual(sent, ['42 [DuckDuckGo]', 'Ada Lovelace was an English mathematician. [Wikipedia]', "I don't have an answer for that."])
  })

  for (const [question, search] of [
    ['what is the capital of France?', /srsearch=capital of France(?!\?)/],
    ["what's the capital of France?", /srsearch=capital of France(?!\?)/],
    ['how does photosynthesis work', /srsearch=photosynthesis work&/]
  ] as const) {
    it(`strips "${question}" for the wiki search`, async () => {
      noKey()
      const { urls } = sources({ wiki: ['X', 'An answer.'] })
      const { sent, ask } = chat(state)
      await ask(`ask ${question}`)
      assert.match(wikiSearch(urls), search)
      assert.deepStrictEqual(sent, ['An answer. [Wikipedia]'])
    })
  }

  it('sends gemini the raw question with a roomy token budget', async () => {
    withKey()
    const { bodies } = sources({ gemini: 'Paris.' })
    const { ask } = chat(state)
    await ask("ask what's the capital of France?")
    assert.strictEqual(bodies[0]!.contents[0]!.parts[0]!.text, "what's the capital of France?")
    assert.ok(bodies[0]!.generationConfig.maxOutputTokens >= 1000)
    assert.match(bodies[0]!.systemInstruction.parts[0]!.text, /short/i)
  })

  for (const [name, prefix, src, host, reply] of [
    ['gemini', 'gg', { gemini: 'Direct.' }, /generativelanguage\.googleapis\.com/, 'Direct. [Gemini]'],
    ['duckduckgo', 'ddg', { ddg: 'Direct.' }, /duckduckgo\.com/, 'Direct. [DuckDuckGo]'],
    ['wikipedia', 'wiki', { wiki: ['Rust', 'Direct.'] }, /wikipedia/, 'Direct. [Wikipedia]'],
    ['an empty duckduckgo, without falling back', 'ddg', {}, /duckduckgo\.com/, "I don't have an answer for that."]
  ] as const) {
    it(`asks only ${name} with "ask ${prefix}"`, async () => {
      withKey()
      const { urls } = sources(src as Sources)
      const { sent, ask } = chat(state)
      await ask(`ask ${prefix} rust programming language`)
      assert.ok(urls.every(u => host.test(u)), urls.join())
      assert.deepStrictEqual(sent, [reply])
    })
  }

  it('tries the next gemini model when one is busy', async () => {
    withKey()
    const models: string[] = []
    mock.method(globalThis, 'fetch', async (url: string) => {
      models.push(url.match(/models\/([\w.-]+):/)?.[1] ?? url)
      if (url.includes('gemini-flash-latest')) return { ok: false, status: 503 }
      return { ok: true, json: async () => geminiBody('Lite answer.') }
    })
    const { sent, ask } = chat(state)
    await ask('ask gg what is a monad')
    assert.deepStrictEqual(models, ['gemini-flash-latest', 'gemini-flash-lite-latest'])
    assert.match(sent[0]!, /Lite answer\./)
  })
})
