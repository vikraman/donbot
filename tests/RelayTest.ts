import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordMessage } from 'hubot'

import { neutraliseDiscordPings, parseBridges, silenceZulipMentions } from '../scripts/Relay.ts'
import type { ZulipMessage } from '../scripts/lib/zulip.ts'
import { setupRobot, chat, collect, collectRooms, brainUser } from './helpers/setup.ts'
import { tick, withMessage } from './helpers/fakes.ts'
import { fc } from './helpers/arb.ts'

const ENV = ['ZULIP_SITE', 'ZULIP_BOT_EMAIL', 'ZULIP_API_KEY', 'RELAY_BRIDGES', 'ZULIP_DM_CHANNEL', 'OWNER_USER_ID']
const BOT = 'donbot-bot@chat.example.org'

interface Call { method: string, path: string, params: Record<string, string> }

// fake zulip, long-polled events
const fakeZulip = () => {
  const calls: Call[] = []
  const pending: ZulipMessage[][] = []
  const opts = { subscribed: true, sendError: '', badQueueOnce: false }
  const signals: AbortSignal[] = []
  let wake: (() => void) | null = null
  let eventId = 0
  let registers = 0
  const ok = (body: Record<string, unknown> = {}) => ({ json: async () => ({ result: 'success', ...body }) })
  const err = (msg: string, code?: string) => ({ json: async () => ({ result: 'error', msg, code }) })

  mock.method(global, 'fetch', async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const path = u.pathname.replace('/api/v1', '')
    const method = init.method || 'GET'
    const params = Object.fromEntries(method === 'GET' ? u.searchParams : new URLSearchParams(init.body as string))
    calls.push({ method, path, params })
    if (path === '/register') return ok({ queue_id: `q${++registers}`, last_event_id: -1 })
    if (path === '/events') {
      if (init.signal) signals.push(init.signal)
      if (opts.badQueueOnce) {
        opts.badQueueOnce = false
        return err('Bad event queue id', 'BAD_EVENT_QUEUE_ID')
      }
      while (pending.length === 0) {
        await new Promise<void>((resolve, reject) => {
          wake = resolve
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
        })
      }
      const batch = pending.shift() || []
      return ok({ events: batch.map(message => ({ id: ++eventId, type: 'message', message })) })
    }
    if (path === '/messages') return opts.sendError ? err(opts.sendError) : ok({ id: 99 })
    if (path === '/get_stream_id') return ok({ stream_id: 7 })
    if (path.startsWith('/users/')) return ok({ is_subscribed: opts.subscribed })
    if (path.endsWith('/reactions')) return ok()
    return err(`unexpected ${path}`)
  })

  return {
    calls,
    opts,
    signals,
    registers: () => registers,
    sent: () => calls.filter(c => c.path === '/messages'),
    push (message: Partial<ZulipMessage>) {
      pending.push([{
        id: 1, type: 'stream', content: '', subject: '', sender_id: 5,
        sender_email: 'alice@chat.example.org', sender_full_name: 'Alice Z',
        display_recipient: 'general', ...message
      }])
      wake?.()
    }
  }
}

const waitFor = async (cond: () => boolean) => {
  for (let i = 0; i < 200 && !cond(); i++) await tick(1)
}

const idle = () => tick(20)

const configure = (bridges: string, extra: Record<string, string> = {}) => {
  process.env.ZULIP_SITE = 'https://chat.example.org'
  process.env.ZULIP_BOT_EMAIL = BOT
  process.env.ZULIP_API_KEY = 'key'
  process.env.RELAY_BRIDGES = bridges
  delete process.env.ZULIP_DM_CHANNEL
  for (const [k, v] of Object.entries(extra)) process.env[k] = v
}

const rawMessage = (id: string, extra: Record<string, unknown> = {}) => {
  const reactions: string[] = []
  const raw = {
    id,
    member: { displayName: 'Bob D' },
    author: { id: 'u1', username: 'bob' },
    mentions: { users: new Map() },
    attachments: new Map(),
    react: async (emoji: string) => { reactions.push(emoji) },
    ...extra
  }
  return { raw: raw as unknown as DiscordMessage, reactions }
}

describe('relay ping properties', () => {
  const text = fc.array(fc.constantFrom('@', '<', '*', '_', 'everyone', 'HERE', 'x', ' ', '**bob**'), { maxLength: 20 }).map(p => p.join(''))

  it('leaves no live pings, idempotently', () => {
    fc.assert(fc.property(text, t => {
      const d = neutraliseDiscordPings(t)
      assert.doesNotMatch(d, /@(everyone|here)|<@/i)
      assert.strictEqual(neutraliseDiscordPings(d), d)
      const z = silenceZulipMentions(t)
      assert.doesNotMatch(z, /@\*/)
      assert.strictEqual(silenceZulipMentions(z), z)
    }))
  })
})

describe('Relay bridges', () => {
  it('parses topics, general chat and skip junk', () => {
    assert.deepStrictEqual(parseBridges('1=general/donbot chat, 2=social ,bad, =x, 3=a/b/c'), [
      { channel: '1', stream: 'general', topic: 'donbot chat' },
      { channel: '2', stream: 'social', topic: '' },
      { channel: '3', stream: 'a', topic: 'b/c' }
    ])
    assert.deepStrictEqual(parseBridges(undefined), [])
  })
})

describe('Relay', () => {
  const state = setupRobot('Relay.ts', { envVars: ENV, deferLoad: true })

  // configure, fake zulip, load
  const start = async (bridges: string, extra: Record<string, string> = {}, opts: Partial<ReturnType<typeof fakeZulip>['opts']> = {}) => {
    configure(bridges, extra)
    const z = fakeZulip()
    Object.assign(z.opts, opts)
    await state.loadScript()
    return z
  }
  const bob = () => chat(state, { id: 'u1', name: 'bob', room: 'chan-1' })

  it('does nothing and make no requests without config', async () => {
    for (const name of ENV) delete process.env[name]
    const fetchMock = mock.method(global, 'fetch', async () => { throw new Error('no fetch') })
    await state.loadScript()
    const { sent, say, ask } = bob()
    await say('>> hello')
    await ask('relay')
    assert.strictEqual(fetchMock.mock.callCount(), 0)
    assert.deepStrictEqual(sent, ["The Zulip relay isn't set up."])
  })

  it('relays a prefixed discord message to the bridged topic', async () => {
    const z = await start('chan-1=general/donbot')
    const { user, say } = bob()
    const { raw, reactions } = rawMessage('m1')
    withMessage(user, raw)
    await say('>>  hi zulip')
    await waitFor(() => reactions.length > 0)
    assert.deepStrictEqual(z.sent().map(c => c.params), [
      { type: 'stream', to: 'general', topic: 'donbot', content: '**Bob D** (discord): hi zulip' }
    ])
    assert.deepStrictEqual(reactions, ['✅'])
  })

  it('does not relay unprefixed messages or unbridged rooms', async () => {
    const z = await start('chan-1=general/donbot')
    const { say } = bob()
    await say('hi zulip')
    await say('not >> this')
    await say('>> hi zulip', { room: 'chan-2' })
    await idle()
    assert.strictEqual(z.sent().length, 0)
  })

  it('rewrites discord markup and silence zulip mentions', async () => {
    const z = await start('chan-1=general/donbot')
    state.robot.adapter.client = { channels: { cache: new Map([['42', { name: 'memes' }]]) } }
    const { user, say } = bob()
    brainUser(state.robot, '222', 'carol')
    const { raw } = rawMessage('m2', {
      mentions: { users: new Map([['111', { username: 'dave', globalName: 'Dave' }]]) },
      attachments: new Map([['a', { url: 'https://cdn.example/cat.png' }]])
    })
    withMessage(user, raw)
    await say('>> <@111> <@!222> <@333> <@&9> <#42> <:party:123> @**all** @*admins*')
    await waitFor(() => z.sent().length > 0)
    assert.strictEqual(z.sent()[0]?.params.content,
      '**Bob D** (discord): @Dave @carol @someone @role #memes :party: @_**all** @_*admins*\nhttps://cdn.example/cat.png')
  })

  it('relays an edited message only once', async () => {
    const z = await start('chan-1=general/donbot')
    const { user, say } = bob()
    withMessage(user, rawMessage('m3').raw)
    await say('>> hi')
    await say('>> hi (edited)')
    await idle()
    assert.strictEqual(z.sent().length, 1)
  })

  it('reacts with a cross when zulip refuses the message', async () => {
    await start('chan-1=general', {}, { sendError: 'Topics are required in this organization.' })
    const { user, say } = bob()
    const { raw, reactions } = rawMessage('m4')
    withMessage(user, raw)
    await say('>> hi')
    await waitFor(() => reactions.length > 0)
    assert.deepStrictEqual(reactions, ['❌'])
  })

  it('sends to general chat when the bridge has no topic', async () => {
    const z = await start('chan-1=general')
    await bob().say('>> hi')
    await waitFor(() => z.sent().length > 0)
    assert.strictEqual(z.sent()[0]?.params.topic, '')
  })

  it('relays a prefixed zulip message to discord with pings neutralised', async () => {
    const z = await start('chan-1=general/donbot')
    const sent = collect(state.robot)
    z.push({ content: '>> hey @everyone and @**Bob D|12** <@1>', subject: 'Donbot' })
    await waitFor(() => sent.length > 0)
    assert.deepStrictEqual(sent, ['**Alice Z** (zulip): hey @​everyone and @Bob D <​@1>'])
  })

  it('ignores zulip messages from itself, other topics or without the prefix', async () => {
    const z = await start('chan-1=general/donbot')
    const sent = collect(state.robot)
    z.push({ content: '>> loop', subject: 'donbot', sender_email: BOT })
    z.push({ content: '>> elsewhere', subject: 'other' })
    z.push({ content: '>> other stream', subject: 'donbot', display_recipient: 'random' })
    z.push({ content: 'no prefix', subject: 'donbot' })
    z.push({ content: '>> marker', subject: 'donbot' })
    await waitFor(() => sent.length > 0)
    await idle()
    assert.deepStrictEqual(sent, ['**Alice Z** (zulip): marker'])
  })

  it('only take general chat for a topic-less bridge', async () => {
    const z = await start('chan-1=general')
    const sent = collect(state.robot)
    z.push({ content: '>> in a topic', subject: 'stuff' })
    z.push({ content: '>> general', subject: '' })
    await waitFor(() => sent.length > 0)
    await idle()
    assert.deepStrictEqual(sent, ['**Alice Z** (zulip): general'])
  })

  const dm = (content: string, others = 1): Partial<ZulipMessage> => ({
    id: 77,
    type: 'private',
    content,
    subject: '',
    display_recipient: [
      { id: 1, email: BOT, full_name: 'donbot' },
      ...Array.from({ length: others }, (_, i) => ({ id: 5 + i, email: `u${i}@x`, full_name: `U${i}` }))
    ]
  })

  it('relays a dm from a subscriber and react on zulip', async () => {
    const z = await start('chan-1=general/donbot')
    const sent = collect(state.robot)
    z.push(dm('>> psst discord'))
    await waitFor(() => z.calls.some(c => c.path.endsWith('/reactions')))
    assert.deepStrictEqual(sent, ['**Alice Z** (zulip DM): psst discord'])
    assert.ok(z.calls.some(c => c.path === '/users/5/subscriptions/7'))
    assert.deepStrictEqual(z.calls.find(c => c.path === '/messages/77/reactions')?.params, { emoji_name: 'check' })
  })

  it('refuses a dm from a non-subscriber', async () => {
    const z = await start('chan-1=general/donbot', {}, { subscribed: false })
    const sent = collect(state.robot)
    z.push(dm('hello'))
    await waitFor(() => z.sent().length > 0)
    assert.strictEqual(sent.length, 0)
    assert.deepStrictEqual(z.sent()[0]?.params, {
      type: 'direct', to: '[5]', content: 'Sorry, you need to be subscribed to #**general** to relay to Discord.'
    })
  })

  it('ignores group dms', async () => {
    const z = await start('chan-1=general/donbot')
    const sent = collect(state.robot)
    z.push(dm('hello all', 2))
    z.push({ content: '>> marker', subject: 'donbot' })
    await waitFor(() => sent.length > 0)
    await idle()
    assert.deepStrictEqual(sent, ['**Alice Z** (zulip): marker'])
    assert.strictEqual(z.sent().length, 0)
  })

  it('explains when dms have no target channel', async () => {
    const z = await start('chan-1=general/a,chan-2=general/b')
    z.push(dm('hello'))
    await waitFor(() => z.sent().length > 0)
    assert.strictEqual(z.sent()[0]?.params.content, "Relaying from DMs isn't set up here.")
  })

  it('routes dms to ZULIP_DM_CHANNEL when there are several bridges', async () => {
    const z = await start('chan-1=general/a,chan-2=social', { ZULIP_DM_CHANNEL: 'chan-2' })
    const sent = collectRooms(state.robot)
    z.push(dm('hello'))
    await waitFor(() => sent.length > 0)
    assert.deepStrictEqual(sent.map(m => m.room), ['chan-2'])
  })

  it('re-register when the event queue expires', async () => {
    const z = await start('chan-1=general/donbot', {}, { badQueueOnce: true })
    await waitFor(() => z.registers() >= 2)
    assert.strictEqual(z.registers(), 2)
  })

  it('stops polling when the brain closes', async () => {
    const z = await start('chan-1=general/donbot')
    await waitFor(() => z.signals.length > 0)
    state.robot.brain.emit('close')
    assert.ok(z.signals[0]?.aborted)
  })

  it('explains the bridge for the current channel', async () => {
    await start('chan-1=general')
    const { sent, ask } = bob()
    await ask('relay')
    await ask('relay', { room: 'chan-9' })
    assert.deepStrictEqual(sent, [
      'This channel is bridged to Zulip #general > general chat. Start a message with >> to send it there; only those messages cross over.',
      "This channel isn't bridged to Zulip."
    ])
  })

  it('gates relay status to the owner', async () => {
    const z = await start('chan-1=general/donbot', { OWNER_USER_ID: 'owner' })
    await waitFor(() => z.registers() > 0)
    const { sent, ask } = bob()
    await ask('relay status')
    await ask('relay status', { user: brainUser(state.robot, 'owner', 'boss') })
    assert.deepStrictEqual(sent, [
      "That's need-to-know, and you don't need to know.",
      '<#chan-1> ↔ #general > donbot\nZulip DMs → <#chan-1>\nZulip: connected'
    ])
  })
})

describe('Relay listener collisions', () => {
  const state = setupRobot(['Relay.ts', 'Status.ts', 'Roles.ts', 'RateLimit.ts'], { envVars: ENV })

  it('answers relay status exactly once', async () => {
    for (const name of ENV) delete process.env[name]
    const { sent, ask } = chat(state, { id: 'u1', name: 'bob', room: 'chan-1' })
    await ask('relay status')
    await ask('relay')
    assert.strictEqual(sent.length, 2)
  })
})
