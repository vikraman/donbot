// target types

export type TargetId = 'mastodon' | 'bluesky'

export const TARGET_IDS: readonly TargetId[] = ['mastodon', 'bluesky']

export const LABELS: Record<TargetId, string> = { mastodon: 'Mastodon', bluesky: 'Bluesky' }

export interface Image {
  data: Uint8Array
  mime: string
  alt: string
  width: number
  height: number
  focus?: { x: number, y: number }
}

export interface Posted {
  url: string
  // for remove
  ref: string
}

export interface Target {
  id: TargetId
  label: string
  // caption limit
  limit: number
  count: (text: string) => number
  // max image bytes
  maxBytes: number
  post: (text: string, images: Image[], key: string) => Promise<Posted>
  remove: (ref: string) => Promise<void>
}

// http error
export const httpError = async (target: TargetId, res: Response): Promise<Error> => {
  let detail = ''
  try {
    const text = await res.text()
    try {
      const body = JSON.parse(text) as { error?: unknown, message?: unknown }
      const found = body.message ?? body.error
      detail = typeof found === 'string' ? found : ''
    } catch {
      detail = text
    }
  } catch {}
  return new Error(`${target}: HTTP ${res.status}${detail ? ` ${detail.slice(0, 200)}` : ''}`)
}
