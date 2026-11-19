import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'

import { MAX_TEXT } from '../scripts/WebChat.ts'
import { setRandomSource } from '../scripts/lib/random.ts'

// before any test mocks fetch
const realFetch = globalThis.fetch

interface Reply {
  status: number
  body: { replies?: string[], error?: string }
  headers: Headers
}

const post = async (robot: TestRobot, text: unknown, ip = '203.0.113.1'): Promise<Reply> => {
  const { port } = robot.server!.address() as AddressInfo
  const res = await realFetch(`http://127.0.0.1:${port}/chat/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': ip },
    body: JSON.stringify({ text })
  })
  return { status: res.status, body: await res.json() as Reply['body'], headers: res.headers }
}

const mockFetchText = (text: string) =>
  mock.method(globalThis, 'fetch', async () => new Response(text, { status: 200 }))

describe('WebChat testing Hubot scripts', () => {
  const state = setupRobot(['Eightball.ts', 'Fortune.ts', 'Joke.ts', 'Killit.ts', 'Kudos.ts', 'Remind.ts', 'Ask.ts', 'RateLimit.ts', 'WebChat.ts'], {
    envVars: ['GEMINI_API_KEY', 'OWNER_USER_ID'],
    deferLoad: true
  })

  const load = async (env: Record<string, string> = {}) => {
    Object.assign(process.env, env)
    await state.loadScript()
    const before = state.robot.listeners!.length
    await state.robot.loadExternalScripts(['hubot-rules', 'hubot-diagnostics'])
    // their index.js doesn't await loadFile
    while (state.robot.listeners!.length < before + 5) await new Promise(resolve => setImmediate(resolve))
  }

  it('answers an allowed command without touching the adapter', async () => {
    await load()
    const { robot } = state
    const sent = collect(robot)
    const replies = collect(robot, 'reply')
    const res = await post(robot, '8ball will it rain?')
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.replies!.length, 1)
    assert.ok(res.body.replies![0]!.length > 0)
    assert.deepStrictEqual(sent, [])
    assert.deepStrictEqual(replies, [])
  })

  it('accepts a leading bot name', async () => {
    await load()
    const res = await post(state.robot, 'Dumbotheelephant: 8ball really?')
    assert.strictEqual(res.body.replies!.length, 1)
  })

  it('answers allowed commands from external packages', async () => {
    await load()
    const ping = await post(state.robot, 'ping')
    assert.deepStrictEqual(ping.body.replies, ['PONG'])
    const rules = await post(state.robot, 'the rules')
    assert.ok(rules.body.replies!.join('').includes('robot'))
    const echo = await post(state.robot, 'echo hi')
    assert.deepStrictEqual(echo.body.replies, [])
  })

  it('ignores commands that are not public', async () => {
    await load()
    const { robot } = state
    const sent = collect(robot)
    for (const text of ['remind me in 5m to stretch', 'leaderboard', 'adapter', 'time']) {
      const res = await post(robot, text)
      assert.deepStrictEqual(res.body.replies, [], text)
    }
    assert.deepStrictEqual(sent, [])
    assert.strictEqual(robot.brain.get('schedule:remind'), null)
  })

  it('never runs hear listeners for web visitors', async () => {
    await load()
    const { robot } = state
    setRandomSource(() => 0)
    const killit = await post(robot, 'kill the process')
    assert.deepStrictEqual(killit.body.replies, [])
    const kudos = await post(robot, 'rust++')
    assert.deepStrictEqual(kudos.body.replies, [])
    assert.strictEqual(robot.brain.get('plusplus:rust'), null)
  })

  it('still serves chat rooms normally', async () => {
    await load()
    const { robot } = state
    setRandomSource(() => 0)
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, 'kill the process', 'test-room')
    assert.deepStrictEqual(sent, ['Kill it, kill it with fire!'])
  })

  it('lists only public commands in help', async () => {
    await load()
    const res = await post(state.robot, 'help')
    const help = res.body.replies![0]!
    assert.match(help, /Dumbotheelephant 8ball/)
    assert.match(help, /Dumbotheelephant fortune/)
    assert.match(help, /Dumbotheelephant the rules/)
    assert.match(help, /Dumbotheelephant ping/)
    assert.match(help, /Dumbotheelephant ask <question> - Answers <question>, trying DuckDuckGo, then Wikipedia\./)
    assert.match(help, /Dumbotheelephant tell me about <topic> - Same as Dumbotheelephant ask <topic>\./)
    assert.doesNotMatch(help, /remind|kudos|leaderboard|echo|adapter|gemini|ask gg|hubot/i)
  })

  it('rejects bad input', async () => {
    await load()
    assert.strictEqual((await post(state.robot, 42)).status, 400)
    assert.strictEqual((await post(state.robot, '   ')).status, 400)
    assert.strictEqual((await post(state.robot, 'x'.repeat(MAX_TEXT + 1))).status, 400)
  })

  it('rate limits per visitor', async () => {
    await load()
    const { robot } = state
    for (let i = 0; i < 10; i++) assert.strictEqual((await post(robot, '8ball ok?')).status, 200)
    const limited = await post(robot, '8ball ok?')
    assert.strictEqual(limited.status, 429)
    assert.ok(Number(limited.headers.get('retry-after')) > 0)
    assert.strictEqual((await post(robot, '8ball ok?', '198.51.100.7')).status, 200)
  })

  it('keeps gemini out of web asks', async () => {
    await load({ GEMINI_API_KEY: 'test-key' })
    const { robot } = state
    const urls: string[] = []
    mock.method(globalThis, 'fetch', async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify({ AbstractText: 'Answer.' }), { status: 200 })
    })
    assert.deepStrictEqual((await post(robot, 'ask gg what')).body.replies, [])
    assert.deepStrictEqual((await post(robot, 'ask what is rust')).body.replies, ['Answer. [DuckDuckGo]'])
    assert.deepStrictEqual((await post(robot, 'tell me about rust')).body.replies, ['Answer. [DuckDuckGo]'])
    assert.deepStrictEqual((await post(robot, 'ask wiki rust')).body.replies!.length, 1)
    assert.ok(urls.length > 0)
    assert.ok(urls.every(u => !u.includes('generativelanguage')))
  })

  it('still asks gemini in chat rooms', async () => {
    await load({ GEMINI_API_KEY: 'test-key' })
    const { robot } = state
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Gemini says.' }] } }] }), { status: 200 }))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant ask what is rust', 'test-room')
    assert.deepStrictEqual(sent, ['Gemini says. [Gemini]'])
  })

  it('keeps jokes family friendly', async () => {
    await load()
    const { robot } = state
    const urls: string[] = []
    const chuck = [{ value: 'An explicit one.', categories: ['explicit'] }, { value: 'A clean one.', categories: [] }]
    mock.method(globalThis, 'fetch', async (url: string) => {
      urls.push(String(url))
      const body = String(url).includes('chucknorris') ? chuck.shift() : { error: false, type: 'single', joke: 'A safe one.' }
      return new Response(JSON.stringify(body), { status: 200 })
    })
    for (const text of ['joke dark', 'tell me a dark joke']) {
      const reply = (await post(robot, text)).body.replies![0]!
      assert.match(reply, /don't know the "dark" category/, text)
      assert.doesNotMatch(reply.split('Try:')[1]!, /dark/, text)
    }
    assert.deepStrictEqual(urls, [])
    assert.deepStrictEqual((await post(robot, 'joke programming')).body.replies, ['A safe one.'])
    assert.strictEqual(urls.pop(), 'https://v2.jokeapi.dev/joke/programming?safe-mode')
    assert.deepStrictEqual((await post(robot, 'joke chuck')).body.replies, ['A clean one.'])
    const help = (await post(robot, 'help')).body.replies![0]!
    assert.match(help, /Dumbotheelephant joke <category> - .*programming, pun/)
    assert.doesNotMatch(help, /dark/)
  })

  it('keeps visitors apart from the owner', async () => {
    await load({ OWNER_USER_ID: 'owner' })
    mockFetchText('a fortune')
    const res = await post(state.robot, 'fortune')
    assert.deepStrictEqual(res.body.replies, ['a fortune'])
    assert.ok(Object.keys(state.robot.brain.data.users).every(id => !id.startsWith('web:')))
  })

  it('gates before middleware that throws', async () => {
    await load()
    const { robot } = state
    setRandomSource(() => 0)
    robot.listenerMiddleware(async (_context) => { throw new Error('boom') })
    robot.on('error', () => {})
    const res = await post(robot, 'kill the process')
    assert.deepStrictEqual(res.body.replies, [])
  })

  it('serves the page with a nonce csp', async () => {
    await load()
    const { port } = state.robot.server!.address() as AddressInfo
    const res = await realFetch(`http://127.0.0.1:${port}/chat`)
    const csp = res.headers.get('content-security-policy')!
    const nonce = csp.match(/'nonce-([^']+)'/)![1]!
    const html = await res.text()
    // rocket loader would rewrite it and trip the csp
    assert.ok(html.includes(`<script nonce="${nonce}" data-cfasync="false">`))
    assert.strictEqual(res.headers.get('cache-control'), 'no-store')
    assert.ok(html.includes('<title>Chat with Dumbotheelephant</title>'))
  })
})
