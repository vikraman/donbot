// mastodon

import { codepoints } from './caption.ts'
import { httpError, LABELS } from './types.ts'
import type { Image, Target } from './types.ts'

export type Visibility = 'public' | 'unlisted' | 'private'

interface Options {
  base: string
  token: string
  visibility?: Visibility
  // poll interval
  pollMs?: number
}

const POLLS = 30

export const mastodonTarget = ({ base, token, visibility = 'public', pollMs = 1000 }: Options): Target => {
  const root = base.replace(/\/+$/, '')
  const auth = { Authorization: `Bearer ${token}` }

  const upload = async (image: Image): Promise<string> => {
    const form = new FormData()
    form.append('file', new Blob([image.data as Uint8Array<ArrayBuffer>], { type: image.mime }), 'board.jpg')
    form.append('description', image.alt)
    if (image.focus) form.append('focus', `${image.focus.x},${image.focus.y}`)
    const res = await fetch(`${root}/api/v2/media`, { method: 'POST', headers: auth, body: form })
    if (!res.ok) throw await httpError('mastodon', res)
    const media = await res.json() as { id: string, url?: string | null }
    if (res.status !== 202) return media.id
    // processing
    for (let i = 0; i < POLLS; i++) {
      await new Promise(resolve => setTimeout(resolve, pollMs))
      const check = await fetch(`${root}/api/v1/media/${media.id}`, { headers: auth })
      if (check.status === 200) {
        const done = await check.json() as { url?: string | null }
        if (done.url) return media.id
      } else if (check.status !== 206) {
        throw await httpError('mastodon', check)
      }
    }
    throw new Error('mastodon: media is still processing')
  }

  return {
    id: 'mastodon',
    label: LABELS.mastodon,
    limit: 500,
    count: codepoints,
    maxBytes: 8 * 1024 * 1024,
    post: async (text, images, key) => {
      const ids: string[] = []
      for (const image of images) ids.push(await upload(image))
      const res = await fetch(`${root}/api/v1/statuses`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json', 'Idempotency-Key': key },
        body: JSON.stringify({ status: text, media_ids: ids, visibility })
      })
      if (!res.ok) throw await httpError('mastodon', res)
      const status = await res.json() as { id: string, url?: string | null, uri?: string }
      return { url: status.url ?? status.uri ?? `${root}/statuses/${status.id}`, ref: status.id }
    },
    remove: async ref => {
      const res = await fetch(`${root}/api/v1/statuses/${encodeURIComponent(ref)}`, { method: 'DELETE', headers: auth })
      if (!res.ok && res.status !== 404) throw await httpError('mastodon', res)
    }
  }
}
