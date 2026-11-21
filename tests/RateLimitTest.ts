import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'


import { setupRobot, chat, brainUser } from './helpers/setup.ts'
import { clock } from './helpers/fakes.ts'

describe('RateLimit', () => {
  const state = setupRobot('RateLimit.ts', { owner: 'owner-id' })
  beforeEach(() => {
    state.robot.respond(/ping$/i, async res => { await res.send('pong') })
  })

  // n pings from the default user, or another
  const setup = () => {
    const c = chat(state)
    const owner = brainUser(c.robot, 'owner-id', 'boss')
    const pest = brainUser(c.robot, 'pest-id', 'pest')
    const ping = async (n = 1, opts: Parameters<typeof c.ask>[1] = {}) => { for (let i = 0; i < n; i++) await c.ask('ping', opts) }
    const status = (text = "who's rate limited") => c.ask(text, { user: owner })
    return { ...c, owner, pest, ping, status }
  }

  it('cuts off with one dismissal past the limit, then stays silent', async () => {
    const { sent, ping } = setup()
    await ping(5)
    assert.deepStrictEqual(sent, Array(5).fill('pong'))
    await ping()
    assert.strictEqual(sent.length, 6)
    assert.notStrictEqual(sent[5], 'pong')
    await ping(2)
    assert.strictEqual(sent.length, 6)
  })

  it('resumes after the cooldown and doubles it on each offense', async () => {
    const t = clock()
    const { sent, ping } = setup()
    await ping(6)
    t.advance(31_000)
    await ping()
    assert.strictEqual(sent.at(-1), 'pong')
    await ping(5)
    const after = sent.length
    assert.notStrictEqual(sent.at(-1), 'pong')
    // second offense is ~60s
    t.advance(31_000)
    await ping()
    assert.strictEqual(sent.length, after)
    t.advance(30_000)
    await ping()
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('resets the offense count after a long quiet period', async () => {
    const t = clock()
    const { sent, ping } = setup()
    await ping(6)
    t.advance(16 * 60_000)
    await ping()
    assert.strictEqual(sent.at(-1), 'pong')
    await ping(5)
    t.advance(31_000)
    await ping()
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('tracks users and rooms independently', async () => {
    const { sent, ping, pest } = setup()
    await ping(6)
    await ping(1, { user: pest })
    assert.strictEqual(sent.at(-1), 'pong')
    await ping(1, { room: 'room-b' })
    assert.strictEqual(sent.at(-1), 'pong')
  })

  it('exempts the owner', async () => {
    const { sent, ping, owner } = setup()
    await ping(20, { user: owner })
    assert.deepStrictEqual(sent, Array(20).fill('pong'))
  })

  it('ignores unaddressed chatter', async () => {
    const { sent, say, ping } = setup()
    for (let i = 0; i < 10; i++) await say('just chatting away')
    await ping()
    assert.deepStrictEqual(sent, ['pong'])
  })

  it('reports limited users only to the owner', async () => {
    const { sent, ask, status } = setup()
    await ask("who's rate limited")
    assert.strictEqual(sent.at(-1), "That's need-to-know, and you don't need to know.")
    for (const phrase of ["who's rate limited", 'rate limits', 'rate limit status']) {
      await status(phrase)
      assert.strictEqual(sent.at(-1), 'Nobody in the doghouse right now.', phrase)
    }
  })

  for (const [name, channels, where] of [
    ['raw room id without a client', undefined, 'test-room'],
    ['channel name from the client', new Map([['test-room', { name: 'general' }]]), '#general'],
    ['raw room id for unknown channels', new Map(), 'test-room']
  ] as const) {
    it(`lists limited users with the ${name}`, async () => {
      const { robot, sent, ping, pest, status } = setup()
      if (channels) robot.adapter.client = { channels: { cache: channels } }
      await ping(6, { user: pest })
      await status()
      assert.match(sent.at(-1)!, new RegExp(`^<@pest-id> in ${where}: .+ left \\(offense #1\\)$`))
    })
  }

  it('drops users whose cooldown expired from the list', async () => {
    const t = clock()
    const { sent, ping, pest, status } = setup()
    await ping(6, { user: pest })
    t.advance(31_000)
    await status()
    assert.strictEqual(sent.at(-1), 'Nobody in the doghouse right now.')
  })
})
