// bluesky over xrpc

import { facetsFor, graphemes } from './caption.ts'
import { httpError, LABELS } from './types.ts'
import type { Target } from './types.ts'

interface Options {
  handle: string
  password: string
  service?: string
}

interface Session {
  did: string
  accessJwt: string
}

interface Blob {
  $type: 'blob'
  ref: { $link: string }
  mimeType: string
  size: number
}

const BLUESKY_MAX_BYTES = 976_560

export const blueskyTarget = ({ handle, password, service = 'https://bsky.social' }: Options): Target => {
  const root = service.replace(/\/+$/, '')
  let session: Session | undefined

  const login = async (): Promise<Session> => {
    const res = await fetch(`${root}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password })
    })
    if (!res.ok) throw await httpError('bluesky', res)
    session = await res.json() as Session
    return session
  }

  // relogin once on expiry
  const call = async (method: string, init: RequestInit): Promise<Response> => {
    const send = (s: Session) => fetch(`${root}/xrpc/${method}`, { ...init, headers: { ...init.headers as Record<string, string>, Authorization: `Bearer ${s.accessJwt}` } })
    let res = await send(session ?? await login())
    if (res.status === 401 || res.status === 400) {
      if (res.status === 401 || /expired/i.test(await res.clone().text())) res = await send(await login())
    }
    if (!res.ok) throw await httpError('bluesky', res)
    return res
  }

  const json = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })

  return {
    id: 'bluesky',
    label: LABELS.bluesky,
    limit: 300,
    count: graphemes,
    maxBytes: BLUESKY_MAX_BYTES,
    post: async (text, images) => {
      const embedded = []
      for (const image of images) {
        const res = await call('com.atproto.repo.uploadBlob', { method: 'POST', headers: { 'Content-Type': image.mime }, body: image.data as Uint8Array<ArrayBuffer> })
        const { blob } = await res.json() as { blob: Blob }
        embedded.push({ alt: image.alt, image: blob, aspectRatio: { width: image.width, height: image.height } })
      }
      const s = session ?? await login()
      const facets = facetsFor(text)
      const record = {
        $type: 'app.bsky.feed.post',
        text,
        createdAt: new Date().toISOString(),
        langs: ['en'],
        ...facets.length ? { facets } : {},
        embed: { $type: 'app.bsky.embed.images', images: embedded }
      }
      const res = await call('com.atproto.repo.createRecord', json({ repo: s.did, collection: 'app.bsky.feed.post', record }))
      const { uri } = await res.json() as { uri: string }
      const rkey = uri.split('/').at(-1)!
      return { url: `https://bsky.app/profile/${s.did}/post/${rkey}`, ref: uri }
    },
    remove: async ref => {
      // at://did/collection/rkey
      const [, , repo, collection, rkey] = ref.split('/')
      if (!repo || !collection || !rkey) throw new Error(`bluesky: bad record ${ref}`)
      await call('com.atproto.repo.deleteRecord', json({ repo, collection, rkey }))
    }
  }
}
