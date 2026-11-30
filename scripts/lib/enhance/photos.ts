// discord photos

import type { EnhanceOptions } from './board.ts'
import { MAX_DOWNLOAD, prepareImage } from './image.ts'
import type { Prepare, Prepared } from './image.ts'
import { describeStats } from './settings.ts'

export const MAX_PHOTOS = 4

export interface Attachment {
  url: string
  contentType?: string | null
  name?: string | null
  size?: number
}

export interface WithAttachments {
  attachments?: { values: () => Iterable<Attachment> }
}

const IMAGE_NAME = /\.(jpe?g|png|webp|gif|heic|heif|avif|tiff?)$/i

export const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

export const imagesOf = (msg: WithAttachments): Attachment[] =>
  [...msg.attachments?.values() ?? []].filter(a => a.contentType ? a.contentType.startsWith('image/') : IMAGE_NAME.test(a.name ?? a.url.split('?')[0]!))

export const download = async (attachment: Attachment): Promise<Uint8Array> => {
  const tooBig = `${attachment.name ?? 'a photo'} is over ${MAX_DOWNLOAD / 1024 / 1024}MB`
  if (attachment.size && attachment.size > MAX_DOWNLOAD) throw new Error(tooBig)
  const res = await fetch(attachment.url)
  if (!res.ok) throw new Error(`couldn't download a photo (HTTP ${res.status})`)
  const data = new Uint8Array(await res.arrayBuffer())
  if (data.length > MAX_DOWNLOAD) throw new Error(tooBig)
  return data
}

// tests swap the pipeline
let override: Prepare | undefined
const prepare: Prepare = (data, maxBytes, opts) => (override ?? prepareImage)(data, maxBytes, opts)

export interface Processed {
  photo?: Prepared
  error?: string
  // numbered stats line
  line: string
}

// preview cache
const recent = new Map<string, Processed[]>()
const RECENT = 4

export const configurePhotos = (o: { prepare?: Prepare }) => {
  override = o.prepare
  recent.clear()
}

// parallel downloads, serial processing
export const processPhotos = async (msg: WithAttachments, maxBytes: number, enhance: EnhanceOptions, { cache = false } = {}): Promise<Processed[]> => {
  const photos = imagesOf(msg).slice(0, MAX_PHOTOS)
  // cdn paths, not query
  const key = JSON.stringify([photos.map(p => p.url.split('?')[0]), maxBytes, enhance])
  const hit = cache ? recent.get(key) : undefined
  if (hit) return hit
  const data = await Promise.allSettled(photos.map(download))
  const out: Processed[] = []
  for (const [i, d] of data.entries()) {
    try {
      if (d.status === 'rejected') throw d.reason
      const photo = await prepare(d.value, maxBytes, { enhance })
      out.push({ photo, line: `\`${i + 1}\` ${photo.stats ? describeStats(photo.stats, photo) : ''}`.trimEnd() })
    } catch (error) {
      out.push({ error: messageOf(error), line: `\`${i + 1}\` failed: ${messageOf(error)}` })
    }
  }
  if (cache && out.every(p => p.photo)) {
    recent.set(key, out)
    if (recent.size > RECENT) recent.delete(recent.keys().next().value!)
  }
  return out
}
