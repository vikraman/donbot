import { setTimeout as sleep } from 'node:timers/promises'

export interface ZulipConfig {
  site: string
  email: string
  apiKey: string
}

export interface ZulipRecipient {
  id: number
  email: string
  full_name: string
}

export interface ZulipMessage {
  id: number
  type: 'stream' | 'private'
  content: string
  subject: string
  sender_id: number
  sender_email: string
  sender_full_name: string
  stream_id?: number
  // stream name for stream messages, participants for dms
  display_recipient: string | ZulipRecipient[]
}

export interface ZulipEvent {
  id: number
  type: string
  message?: ZulipMessage
}

interface ZulipResult {
  result: 'success' | 'error'
  msg?: string
  code?: string
  [key: string]: unknown
}

export class ZulipError extends Error {
  code?: string
  constructor (msg: string, code?: string) {
    super(msg)
    this.code = code
  }
}

const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 5 * 60 * 1000

export const zulipClient = ({ site, email, apiKey }: ZulipConfig) => {
  const base = `${site.replace(/\/+$/, '')}/api/v1`
  const auth = `Basic ${Buffer.from(`${email}:${apiKey}`).toString('base64')}`

  const call = async (method: string, path: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<ZulipResult> => {
    const form = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) form.set(k, typeof v === 'string' ? v : JSON.stringify(v))
    }
    const query = method === 'GET' && form.size > 0 ? `?${form}` : ''
    const res = await fetch(`${base}${path}${query}`, {
      method,
      headers: { Authorization: auth, ...(method === 'GET' ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }) },
      body: method === 'GET' ? undefined : form.toString(),
      signal
    })
    const body = await res.json() as ZulipResult
    if (body.result !== 'success') throw new ZulipError(body.msg || `zulip ${method} ${path} failed`, body.code)
    return body
  }

  const register = async (signal?: AbortSignal): Promise<{ queueId: string, lastEventId: number }> => {
    const body = await call('POST', '/register', {
      event_types: ['message'],
      apply_markdown: false,
      // general chat arrives as subject "" instead of a localized label
      // required by the api
      client_capabilities: { notification_settings_null: true, empty_topic_name: true }
    }, signal)
    return { queueId: String(body.queue_id), lastEventId: Number(body.last_event_id) }
  }

  const poll = async (queueId: string, lastEventId: number, signal?: AbortSignal): Promise<ZulipEvent[]> => {
    const body = await call('GET', '/events', { queue_id: queueId, last_event_id: String(lastEventId) }, signal)
    return (body.events as ZulipEvent[] | undefined) || []
  }

  const sendStream = async (stream: string, topic: string, content: string): Promise<void> => {
    await call('POST', '/messages', { type: 'stream', to: stream, topic, content })
  }

  const sendDirect = async (userId: number, content: string): Promise<void> => {
    await call('POST', '/messages', { type: 'direct', to: [userId], content })
  }

  const react = async (messageId: number, emojiName: string): Promise<void> => {
    await call('POST', `/messages/${messageId}/reactions`, { emoji_name: emojiName })
  }

  const streamId = async (stream: string): Promise<number> => {
    const body = await call('GET', '/get_stream_id', { stream })
    return Number(body.stream_id)
  }

  const isSubscribed = async (userId: number, stream: number): Promise<boolean> => {
    const body = await call('GET', `/users/${userId}/subscriptions/${stream}`)
    return body.is_subscribed === true
  }

  // long-polls until aborted; re-registers on expired queues
  const run = async (
    onEvent: (event: ZulipEvent) => unknown,
    { signal, onState }: { signal: AbortSignal, onState?: (connected: boolean, error?: string) => void }
  ): Promise<void> => {
    let queue: { queueId: string, lastEventId: number } | null = null
    let backoff = MIN_BACKOFF_MS
    while (!signal.aborted) {
      try {
        if (!queue) {
          queue = await register(signal)
          onState?.(true)
        }
        const events = await poll(queue.queueId, queue.lastEventId, signal)
        for (const event of events) {
          queue.lastEventId = Math.max(queue.lastEventId, event.id)
          try {
            await onEvent(event)
          } catch {
            // one bad event shouldn't kill the loop
          }
        }
        backoff = MIN_BACKOFF_MS
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof ZulipError && err.code === 'BAD_EVENT_QUEUE_ID') {
          queue = null
          continue
        }
        queue = null
        onState?.(false, err instanceof Error ? err.message : String(err))
        try {
          await sleep(backoff, undefined, { signal })
        } catch {
          return
        }
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  return { register, poll, sendStream, sendDirect, react, streamId, isSubscribed, run }
}

export type ZulipClient = ReturnType<typeof zulipClient>
