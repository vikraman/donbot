import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import type { EventEmitter } from 'node:events'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import { discordMessage, fakeClient, runDueJobs, settle, withMessage } from './helpers/fakes.ts'

import { configurePhotos } from '../scripts/lib/enhance/photos.ts'
import { configureSocial } from '../scripts/lib/social/index.ts'
import type { Image, Target, TargetId } from '../scripts/lib/social/types.ts'
import { parseHere } from '../scripts/Social.ts'
import { PRESETS } from '../scripts/lib/enhance/board.ts'
import { policyFor } from '../scripts/lib/policy.ts'

interface Call {
  target: TargetId
  text: string
  images: Image[]
}

const fakeTarget = (id: TargetId, calls: Call[], removed: string[], fail = { times: 0 }): Target => ({
  id,
  label: id === 'mastodon' ? 'Mastodon' : 'Bluesky',
  limit: id === 'mastodon' ? 500 : 300,
  count: s => [...s].length,
  maxBytes: 1000,
  post: async (text, images) => {
    if (fail.times > 0) {
      fail.times--
      throw new Error(`${id}: HTTP 503`)
    }
    calls.push({ target: id, text, images })
    return { url: `https://${id}.example/p/${calls.length}`, ref: `${id}-ref` }
  },
  remove: async ref => { removed.push(ref) }
})

interface MsgOptions {
  author?: string
  content?: string
  photos?: number
  staff?: string[]
}

describe('Social', () => {
  const state = setupRobot('Social.ts', { deferLoad: true, envVars: ['OWNER_USER_ID'] })
  let calls: Call[]
  let removed: string[]
  let bskyFail: { times: number }
  let messages: Map<string, Record<string, unknown>>
  let reacted: string[]
  let prepOpts: unknown[]
  let previews: { content: string, files: string[] }[]

  beforeEach(() => {
    delete process.env.OWNER_USER_ID
    calls = []
    removed = []
    bskyFail = { times: 0 }
    messages = new Map()
    reacted = []
    prepOpts = []
    previews = []
    configureSocial({
      targets: () => ({ mastodon: fakeTarget('mastodon', calls, removed), bluesky: fakeTarget('bluesky', calls, removed, bskyFail) })
    })
    configurePhotos({
      prepare: async (data, _max, opts) => {
        prepOpts.push(opts)
        const stats = { inWidth: 8, inHeight: 6, inBytes: 3, outBytes: 3, metadata: 'location' as const }
        return { data, mime: 'image/jpeg', width: 4, height: 3, stats }
      }
    })
    mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }))
  })

  const message = (id: string, { author = 'alice', content = 'Today on the board', photos = 1, staff = [] }: MsgOptions = {}) => {
    const perms = (yes: boolean) => ({ has: (flag: string) => flag === 'ManageChannels' && yes })
    const msg = {
      id, channelId: 'boards', guildId: 'g1', content, partial: false,
      author: { id: author },
      attachments: new Map(Array.from({ length: photos }, (_x, i) => [`a${i}`, { url: `https://cdn.example/${id}-${i}.jpg`, contentType: 'image/jpeg', name: `${i}.jpg` }])),
      mentions: { users: new Map([['42', { username: 'carol', globalName: 'Carol' }]]) },
      guild: { members: { fetch: async (uid: string) => ({ id: uid, permissions: perms(false), staff: staff.includes(uid) }) } },
      channel: { permissionsFor: (member: { staff: boolean }) => perms(member.staff) },
      react: async (emoji: string) => { reacted.push(emoji) }
    }
    messages.set(id, msg)
    return msg
  }

  // server g1, social on by default
  const start = async ({ enabled = true } = {}) => {
    const channel = { id: 'boards', guildId: 'g1', send: async (o: { content: string, files: { name: string }[] }) => { previews.push({ content: o.content, files: o.files.map(f => f.name) }); state.robot.emit('send', { room: 'boards' }, o.content) }, messages: { fetch: async (id: string) => {
      const m = messages.get(id)
      if (!m) throw Object.assign(new Error('Unknown Message'), { code: 10008 })
      return m
    } } }
    const others = ['lab', 'other', 'elsewhere'].map(id => [id, { id, guildId: 'g1' }] as const)
    const client = await fakeClient(state, { channels: { cache: new Map<string, unknown>([['boards', channel], ...others]), fetch: async () => channel } })
    if (enabled) policyFor(state.robot).update(d => { d.guilds.g1 = { on: ['social'], off: [] } })
    state.robot.brain.set('social:channel:boards', { targets: ['mastodon', 'bluesky'], holdMs: 600_000, tag: '#whiteboard', by: 'staff', at: 0 })
    return client
  }

  const reactTo = async (client: EventEmitter, msg: unknown, emoji: string, by: string, added = true) => {
    client.emit(added ? 'messageReactionAdd' : 'messageReactionRemove', { partial: false, emoji: { name: emoji }, message: msg }, { id: by, bot: false })
    await settle()
    await settle()
  }

  it('queues on the poster\'s 📣 and posts after the hold, with the edited caption', async () => {
    const client = await start()
    const sent = collect(state.robot)
    const msg = message('m1', { content: 'Coherence for <@42>\nalt: Diagram of a pentagon' })
    await reactTo(client, msg, '📣', 'alice')
    assert.match(sent.at(-1)!, /^📣 Sending to Mastodon and Bluesky today at .*React ❌/)
    assert.strictEqual(calls.length, 0)
    msg.content = 'Coherence for <@42>, fixed\nalt: Diagram of a pentagon'
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls.map(c => [c.target, c.text, c.images.map(i => i.alt)]), [
      ['mastodon', 'Coherence for Carol, fixed\n\n#whiteboard', ['Diagram of a pentagon']],
      ['bluesky', 'Coherence for Carol, fixed\n\n#whiteboard', ['Diagram of a pentagon']]
    ])
    assert.match(sent.at(-1)!, /^📣 Posted:\nMastodon: <https:\/\/mastodon\.example\/p\/1>\nBluesky: </)
    assert.deepStrictEqual(reacted, ['✅'])
    // second 📣
    await reactTo(client, msg, '📣', 'alice')
    await runDueJobs(state.robot, 'social')
    assert.strictEqual(calls.length, 2)
  })

  it('nudges for missing alt text and uses the default', async () => {
    const client = await start()
    const sent = collect(state.robot)
    await reactTo(client, message('m1', { photos: 2, content: 'alt 2: Second board' }), '📣', 'alice')
    assert.match(sent.at(-1)!, /Add `alt: …` lines/)
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls[0]!.images.map(i => i.alt), ['Whiteboard photo', 'Second board'])
    assert.strictEqual(calls[0]!.text, '#whiteboard')
  })

  it('lets staff queue but not other people', async () => {
    const client = await start()
    const sent = collect(state.robot)
    await reactTo(client, message('m1', { staff: ['sam'] }), '📣', 'bob')
    assert.match(sent.at(-1)!, /Only the person who posted it or channel staff/)
    await reactTo(client, messages.get('m1'), '📣', 'bob')
    assert.strictEqual(sent.length, 1)
    await reactTo(client, messages.get('m1'), '📣', 'sam')
    assert.match(sent.at(-1)!, /^📣 Sending/)
  })

  it('cancels on ❌ or when the 📣 is taken back', async () => {
    const client = await start()
    const sent = collect(state.robot)
    const a = message('m1')
    await reactTo(client, a, '📣', 'alice')
    await reactTo(client, a, '❌', 'bob')
    assert.match(sent.at(-1)!, /^📣 Sending/)
    await reactTo(client, a, '❌', 'alice')
    assert.strictEqual(sent.at(-1), '📣 Cancelled. Nothing was sent.')
    const b = message('m2')
    await reactTo(client, b, '📣', 'alice')
    await reactTo(client, b, '📣', 'alice', false)
    assert.strictEqual(sent.at(-1), '📣 Cancelled. Nothing was sent.')
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls, [])
  })

  it('drops deleted messages and photo-less ones', async () => {
    const client = await start()
    const sent = collect(state.robot)
    await reactTo(client, message('m1', { photos: 0 }), '📣', 'alice')
    assert.strictEqual(sent.at(-1), '📣 There\'s no photo on that message.')
    await reactTo(client, message('m2'), '📣', 'alice')
    messages.delete('m2')
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls, [])
    assert.strictEqual(state.robot.brain.get<{ status: string }>('social:post:m2')!.status, 'cancelled')
  })

  it('retries only the target that failed', async () => {
    const client = await start()
    const sent = collect(state.robot)
    bskyFail.times = 1
    await reactTo(client, message('m1'), '📣', 'alice')
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls.map(c => c.target), ['mastodon'])
    assert.match(sent.at(-1)!, /^📣 Sending/)
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls.map(c => c.target), ['mastodon', 'bluesky'])
    assert.match(sent.at(-1)!, /^📣 Posted:/)
  })

  it('reports a target that keeps failing, keeping what went out', async () => {
    const client = await start()
    const sent = collect(state.robot)
    bskyFail.times = 10
    await reactTo(client, message('m1'), '📣', 'alice')
    for (let i = 0; i < 3; i++) await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls.map(c => c.target), ['mastodon'])
    assert.match(sent.at(-1)!, /^📣 Posted:\nMastodon: <.*>\nBut it didn't go out: bluesky: HTTP 503$/)
  })

  it('deletes sent posts on 🗑️ and by command', async () => {
    const client = await start()
    const sent = collect(state.robot)
    const msg = message('m1')
    await reactTo(client, msg, '📣', 'alice')
    await runDueJobs(state.robot, 'social')
    await reactTo(client, msg, '🗑️', 'alice')
    assert.deepStrictEqual(removed, ['mastodon-ref', 'bluesky-ref'])
    assert.strictEqual(sent.at(-1), '🗑️ Deleted from Mastodon and Bluesky.')

    const other = message('m2', { author: 'dave' })
    await reactTo(client, other, '📣', 'dave')
    await runDueJobs(state.robot, 'social')
    const ask = async (id: string, text: string, staff = false) => {
      const user = withMessage(brainUser(state.robot, id, id), discordMessage('boards', id, { manageChannels: staff }))
      await state.robot.adapter.say(user, `@${state.robot.name} ${text}`, 'boards')
    }
    await ask('erin', 'social retract https://discord.com/channels/g1/boards/m2')
    assert.match(sent.at(-1)!, /haven't queued or posted/)
    await ask('erin', 'social retract https://discord.com/channels/g1/boards/12345')
    assert.match(sent.at(-1)!, /haven't queued or posted/)
  })

  it('previews the processed photos with what changed', async () => {
    const client = await start()
    await reactTo(client, message('m1', { photos: 2 }), '📣', 'alice')
    assert.strictEqual(previews.length, 1)
    assert.deepStrictEqual(previews[0]!.files, ['preview-1.jpg', 'preview-2.jpg'])
    assert.match(previews[0]!.content, /^📣 Sending to Mastodon and Bluesky/)
    assert.match(previews[0]!.content, /`1` not enhanced · 8×6→4×3 · 3B→3B · GPS removed/)
    assert.match(previews[0]!.content, /`enhance:` line \(mild\|strong\|off/)
    assert.deepStrictEqual(prepOpts[0], { enhance: PRESETS.mild })
  })

  it('takes enhance settings from the message over the channel default', async () => {
    const client = await start()
    const sent = collect(state.robot)
    const rule = state.robot.brain.get<Record<string, unknown>>('social:channel:boards')!
    state.robot.brain.set('social:channel:boards', { ...rule, enhance: { preset: 'strong', clean: 'high' } })
    const msg = message('m1', { content: 'Board\nenhance: brightness 30, nocrop' })
    await reactTo(client, msg, '📣', 'alice')
    assert.deepStrictEqual(prepOpts.at(-1), { enhance: { ...PRESETS.strong, clean: 'high', brightness: 0.3, crop: 'off' } })
    msg.content = 'Board\nenhance: off'
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(prepOpts.at(-1), { enhance: PRESETS.off })
    assert.strictEqual(calls[0]!.text, 'Board\n\n#whiteboard')
    await reactTo(client, message('m2', { content: 'enhance: sparkly' }), '📣', 'alice')
    assert.match(previews.at(-1)!.content, /enhance line didn't parse \(I don't know "sparkly"\)/)
    assert.ok(sent.some(t => t.startsWith('📣 Posted')))
  })

  it('refuses to bind a dm, and staff elsewhere can\'t retract', async () => {
    const client = await start()
    const sent = collect(state.robot)
    const user = withMessage(brainUser(state.robot, 'eve', 'eve'), discordMessage('dm-eve', 'eve', { guild: null }))
    await state.robot.adapter.say(user, `@${state.robot.name} social here`, 'dm-eve')
    assert.strictEqual(sent.at(-1), 'Social posting works in server channels, not DMs.')
    assert.strictEqual(state.robot.brain.get('social:channel:dm-eve'), null)
    await reactTo(client, message('123456789'), '📣', 'alice')
    await runDueJobs(state.robot, 'social')
    for (const [room, guild] of [['dm-eve', null], ['other', 'g1']] as const) {
      const staff = withMessage(brainUser(state.robot, 'eve', 'eve'), discordMessage(room, 'eve', { guild, manageChannels: true }))
      await state.robot.adapter.say(staff, `@${state.robot.name} social retract https://discord.com/channels/g1/boards/123456789`, room)
      assert.match(sent.at(-1)!, /Only the person who posted it or channel staff/)
    }
    assert.deepStrictEqual(removed, [])
  })

  it('deletes copies already posted when a part-sent photo is cancelled', async () => {
    const client = await start()
    const sent = collect(state.robot)
    bskyFail.times = 1
    const msg = message('m1')
    await reactTo(client, msg, '📣', 'alice')
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls.map(c => c.target), ['mastodon'])
    await reactTo(client, msg, '❌', 'alice')
    assert.deepStrictEqual(removed, ['mastodon-ref'])
    assert.strictEqual(sent.at(-1), '📣 Cancelled. 🗑️ Deleted from Mastodon.')
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls.map(c => c.target), ['mastodon'])
  })

  it('stays off in servers that haven\'t turned it on', async () => {
    const client = await start({ enabled: false })
    const sent = collect(state.robot)
    await reactTo(client, message('m1'), '📣', 'alice')
    await runDueJobs(state.robot, 'social')
    assert.deepStrictEqual(calls, [])
    assert.ok(sent.every(t => !t.startsWith('📣')))
    // gate blocks commands
    assert.ok(!policyFor(state.robot).allowsRoom('boards', 'social'))
  })

  it('ignores unbound channels', async () => {
    const client = await start()
    const sent = collect(state.robot)
    const msg = { ...message('m1'), channelId: 'elsewhere', channel: { permissionsFor: () => null } }
    await reactTo(client, msg, '📣', 'alice')
    assert.deepStrictEqual(sent, [])
  })

  it('binds a channel for staff only', async () => {
    await start()
    const sent = collect(state.robot)
    const ask = async (id: string, text: string, staff = false) => {
      const user = withMessage(brainUser(state.robot, id, id), discordMessage('lab', id, { manageChannels: staff }))
      await state.robot.adapter.say(user, `@${state.robot.name} ${text}`, 'lab')
    }
    await ask('bob', 'social here')
    assert.strictEqual(sent.at(-1), 'Only someone who can manage this channel can do that.')
    await ask('sam', 'social here mastodon hold 5m tag whiteboard, category theory', true)
    assert.match(sent.at(-1)!, /sends 📣'd photos to Mastodon 5m after the 📣, tagged #whiteboard #category #theory, enhance mild \(brightness 50, contrast 0, color 100, clean normal, crop straighten\)/)
    await ask('sam', 'social here hold none', true)
    assert.match(sent.at(-1)!, /to Mastodon right after/)
    await ask('bob', 'social status')
    assert.match(sent.at(-1)!, /Mastodon: set up, Bluesky: set up/)
    await ask('sam', 'social off', true)
    assert.strictEqual(sent.at(-1), '📣 This channel won\'t send photos any more.')
  })
})

describe('parseHere', () => {
  it('reads targets, hold and tags in any order', () => {
    assert.deepStrictEqual(parseHere('bluesky tag #a b hold 1h'), { targets: ['bluesky'], holdMs: 3_600_000, tag: '#a #b' })
    assert.deepStrictEqual(parseHere(''), {})
    assert.deepStrictEqual(parseHere('hold 0'), { holdMs: 0 })
    assert.match(parseHere('twitter') as string, /not twitter/)
    assert.match(parseHere('hold 3 days') as string, /up to a day/)
    assert.deepStrictEqual(parseHere('tag #enhance #maths'), { tag: '#enhance #maths' })
  })
})
