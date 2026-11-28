import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { fc } from './helpers/arb.ts'

import { blueskyTarget } from '../scripts/lib/social/bluesky.ts'
import { cleanText, facetsFor, fitCaption, graphemes, parseAlts, truncate } from '../scripts/lib/social/caption.ts'
import { mastodonTarget } from '../scripts/lib/social/mastodon.ts'

interface Req {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

// scripted fetch
const script = (replies: [number, unknown][]): Req[] => {
  const reqs: Req[] = []
  mock.method(globalThis, 'fetch', async (url: string, init: RequestInit = {}) => {
    reqs.push({ url: String(url), method: init.method ?? 'GET', headers: (init.headers ?? {}) as Record<string, string>, body: init.body })
    const [status, body] = replies.shift() ?? [500, { error: 'unexpected' }]
    const text = JSON.stringify(body)
    const res = { ok: status < 300, status, json: async () => body, text: async () => text }
    return { ...res, clone: () => res }
  })
  return reqs
}

// byte-range slice
const byteSlice = (text: string, start: number, end: number): string =>
  new TextDecoder().decode(new TextEncoder().encode(text).slice(start, end))

const image = { data: new Uint8Array([1, 2]), mime: 'image/jpeg', alt: 'A board', width: 4, height: 3, focus: { x: -0.5, y: 0.25 } }

describe('captions', () => {
  it('pulls alt lines out of the text', () => {
    assert.deepStrictEqual(parseAlts('Hello\nalt: one\nALT 3: three\nalt:two\nbye'), { body: 'Hello\nbye', alts: ['one', 'two', 'three'] })
  })

  it('cleans discord markup', () => {
    assert.strictEqual(cleanText('hi <@1> <@&2> <#3> <:pog:4> ||secret|| @everyone <https://x.org>', id => id === '1' ? 'Ann' : undefined), 'hi Ann secret everyone https://x.org')
  })

  it('fits within limits and keeps the tag', () => {
    const body = 'word '.repeat(100).trim()
    const fit = fitCaption(body, '#whiteboard', 300)
    assert.ok(graphemes(fit) <= 300)
    assert.ok(fit.endsWith('…\n\n#whiteboard'))
    assert.strictEqual(fitCaption('has #Whiteboard', '#whiteboard', 300), 'has #Whiteboard')
  })

  it('never goes over the limit', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 600 }), fc.integer({ min: 1, max: 400 }), (text, max) => {
      assert.ok(graphemes(truncate(text, max)) <= max)
      assert.ok([...truncate(text, max, s => [...s].length)].length <= max)
    }))
  })

  it('places facets on the right bytes', () => {
    const text = 'Über #kategorie see https://ncatlab.org/x. and #2 #a1'
    const facets = facetsFor(text)
    assert.deepStrictEqual(facets.map(f => byteSlice(text, f.index.byteStart, f.index.byteEnd)), ['#kategorie', 'https://ncatlab.org/x', '#a1'])
    fc.assert(fc.property(fc.string({ unit: 'grapheme', maxLength: 40 }), fc.stringMatching(/^[a-z]{1,10}$/), (pre, tag) => {
      const t = `${pre} #${tag}`
      const f = facetsFor(t).at(-1)!
      assert.strictEqual(byteSlice(t, f.index.byteStart, f.index.byteEnd), `#${tag}`)
    }))
  })
})

describe('mastodon', () => {
  it('uploads, waits for processing, posts and deletes', async () => {
    const reqs = script([[202, { id: 'med1', url: null }], [206, {}], [200, { id: 'med1', url: 'https://m/x.jpg' }], [200, { id: 's1', url: 'https://m.example/@lab/s1' }], [200, {}]])
    const target = mastodonTarget({ base: 'https://m.example/', token: 'tok', visibility: 'unlisted', pollMs: 1 })
    const posted = await target.post('hello', [image], 'donbot-1')
    assert.deepStrictEqual(posted, { url: 'https://m.example/@lab/s1', ref: 's1' })
    assert.deepStrictEqual(reqs.map(r => `${r.method} ${r.url}`), [
      'POST https://m.example/api/v2/media', 'GET https://m.example/api/v1/media/med1', 'GET https://m.example/api/v1/media/med1', 'POST https://m.example/api/v1/statuses'
    ])
    const form = reqs[0]!.body as FormData
    assert.strictEqual(form.get('description'), 'A board')
    assert.strictEqual(form.get('focus'), '-0.5,0.25')
    assert.strictEqual(reqs[3]!.headers['Idempotency-Key'], 'donbot-1')
    assert.deepStrictEqual(JSON.parse(reqs[3]!.body as string), { status: 'hello', media_ids: ['med1'], visibility: 'unlisted' })
    await target.remove('s1')
    assert.strictEqual(`${reqs[4]!.method} ${reqs[4]!.url}`, 'DELETE https://m.example/api/v1/statuses/s1')
  })

  it('surfaces errors', async () => {
    script([[422, { error: 'Validation failed' }]])
    await assert.rejects(mastodonTarget({ base: 'https://m.example', token: 't' }).post('x', [image], 'k'), /mastodon: HTTP 422 Validation failed/)
  })
})

describe('bluesky', () => {
  it('logs in, uploads, posts with facets and deletes', async () => {
    const blob = { $type: 'blob', ref: { $link: 'bafy' }, mimeType: 'image/jpeg', size: 2 }
    const reqs = script([
      [200, { did: 'did:plc:lab', accessJwt: 'jwt1' }],
      [200, { blob }],
      [200, { uri: 'at://did:plc:lab/app.bsky.feed.post/3abc', cid: 'c' }],
      [400, { error: 'ExpiredToken', message: 'Token has expired' }],
      [200, { did: 'did:plc:lab', accessJwt: 'jwt2' }],
      [200, {}]
    ])
    const target = blueskyTarget({ handle: 'lab.bsky.social', password: 'app-pw' })
    const posted = await target.post('new #board', [image], 'k')
    assert.deepStrictEqual(posted, { url: 'https://bsky.app/profile/did:plc:lab/post/3abc', ref: 'at://did:plc:lab/app.bsky.feed.post/3abc' })
    assert.strictEqual(reqs[1]!.headers.Authorization, 'Bearer jwt1')
    const record = (JSON.parse(reqs[2]!.body as string) as { record: { text: string, facets: unknown[], embed: unknown } }).record
    assert.strictEqual(record.text, 'new #board')
    assert.deepStrictEqual(record.facets, [{ index: { byteStart: 4, byteEnd: 10 }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: 'board' }] }])
    assert.deepStrictEqual(record.embed, { $type: 'app.bsky.embed.images', images: [{ alt: 'A board', image: blob, aspectRatio: { width: 4, height: 3 } }] })
    // expired token
    await target.remove(posted.ref)
    assert.deepStrictEqual(reqs.slice(3).map(r => r.url.split('/xrpc/')[1]), ['com.atproto.repo.deleteRecord', 'com.atproto.server.createSession', 'com.atproto.repo.deleteRecord'])
    assert.deepStrictEqual(JSON.parse(reqs[5]!.body as string), { repo: 'did:plc:lab', collection: 'app.bsky.feed.post', rkey: '3abc' })
  })
})
