import { beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import { withMessage } from './helpers/fakes.ts'

import { configurePhotos } from '../scripts/lib/enhance/photos.ts'
import { PRESETS } from '../scripts/lib/enhance/board.ts'

interface Reply {
  content: string
  files: string[]
  replyTo?: string
}

describe('Enhance', () => {
  const state = setupRobot('Enhance.ts')
  let opts: unknown[]
  let replies: Reply[]

  beforeEach(() => {
    opts = []
    replies = []
    configurePhotos({
      prepare: async (data, _max, o) => {
        opts.push(o)
        return { data, mime: 'image/jpeg', width: 4, height: 3, stats: { inWidth: 8, inHeight: 6, inBytes: 3, outBytes: 3, metadata: 'location' } }
      }
    })
    const send = async (o: { content: string, files: { name: string }[], reply?: { messageReference: string } }) => {
      replies.push({ content: o.content, files: o.files.map(f => f.name), ...o.reply ? { replyTo: o.reply.messageReference } : {} })
    }
    state.robot.adapter.client = { channels: { cache: new Map([['room', { send }]]) } } as unknown as typeof state.robot.adapter.client
    mock.method(globalThis, 'fetch', async () => ({ ok: true, status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }))
  })

  const photos = (n: number) => new Map(Array.from({ length: n }, (_x, i) => [`a${i}`, { url: `https://cdn.example/${i}.jpg`, contentType: 'image/jpeg', name: `${i}.jpg` }]))

  // raw message from alice
  const say = async (text: string, { count = 1, replyTo }: { count?: number, replyTo?: Record<string, unknown> } = {}) => {
    const raw = {
      id: 'msg-1', guildId: 'g1', author: { id: 'alice' }, attachments: photos(count),
      ...replyTo ? { reference: { messageId: 'orig' } } : {},
      channel: { messages: { fetch: async () => replyTo } }
    }
    const user = withMessage(brainUser(state.robot, 'alice', 'alice'), raw)
    await state.robot.adapter.say(user, `@${state.robot.name} ${text}`, 'room')
  }

  it('replies with the enhanced photos and a terse line each', async () => {
    await say('enhance', { count: 2 })
    assert.deepStrictEqual(replies, [{ content: '`1` not enhanced · 8×6→4×3 · 3B→3B · GPS removed\n`2` not enhanced · 8×6→4×3 · 3B→3B · GPS removed', files: ['enhanced-1.jpg', 'enhanced-2.jpg'], replyTo: 'msg-1' }])
    assert.deepStrictEqual(opts, [{ enhance: PRESETS.mild }, { enhance: PRESETS.mild }])
  })

  it('takes combined settings', async () => {
    await say('enhance strong, color 100, nocrop, clean high')
    assert.deepStrictEqual(opts, [{ enhance: { ...PRESETS.strong, color: 1, crop: 'off', clean: 'high' } }])
  })

  it('works on the message it replies to', async () => {
    await say('enhance off straighten', { count: 0, replyTo: { attachments: photos(1) } })
    assert.strictEqual(replies.length, 1)
    assert.deepStrictEqual(opts, [{ enhance: { ...PRESETS.off, crop: 'straighten' } }])
  })

  it('explains itself without photos, on bad settings, and on help', async () => {
    const sent = collect(state.robot)
    await say('enhance', { count: 0 })
    assert.match(sent.at(-1)!, /Attach photos/)
    await say('enhance sparkly')
    assert.match(sent.at(-1)!, /I don't know "sparkly"\. Settings: mild\|strong\|off/)
    await say('enhance help', { count: 0 })
    assert.match(sent.at(-1)!, /`mild`: brightness 50, contrast 0, color 100, clean normal, crop straighten/)
    assert.deepStrictEqual(replies, [])
  })
})
