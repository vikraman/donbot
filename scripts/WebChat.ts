// Description:
//   Public web chat at /chat. Visitors get only the allowlisted commands below; everything
//   else, including hear and catch-all listeners, is dropped for web rooms. Replies are
//   captured and never reach the chat adapter.
//

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { TextMessage, User } from 'hubot'
import type { ListenerMiddlewareContext, Robot } from 'hubot'

import { WEB_PREFIX, isWebRoom } from './lib/web.ts'

interface Allowed {
  id: string
  help: string[]
  // shown instead of the scraped line
  lines?: string[]
}

// public listeners, by hubot listener id
export const ALLOWED: Allowed[] = [
  { id: 'agda.search', help: ['hubot agda <', 'hubot agda search', 'hubot agda about', 'hubot agda type', 'hubot agda more', 'hubot agda index'] },
  { id: 'choose.pick', help: ['hubot choose'] },
  { id: 'choose.roll', help: ['hubot roll a number'] },
  { id: 'choose.rolls', help: ['hubot roll <N>'] },
  { id: 'eightball.ask', help: ['hubot 8ball'] },
  { id: 'fortune.tell', help: ['hubot fortune'] },
  { id: 'futurama.quote', help: ['hubot quote'] },
  { id: 'futurama.entertain', help: ['hubot entertain me'] },
  { id: 'joke.tell', help: ['hubot joke', 'hubot tell me a'] },
  { id: 'xkcd.show', help: ['hubot xkcd'] },
  { id: 'pugme.show', help: ['hubot pug me'] },
  { id: 'garble.text', help: ['hubot garble'] },
  { id: 'define.word', help: ['hubot define'] },
  { id: 'weather.show', help: ['hubot weather'] },
  { id: 'ask.source', help: ['hubot ask ddg', 'hubot ask wiki'] },
  { id: 'ask.question', help: [], lines: ['hubot ask <question> - Answers <question>, trying DuckDuckGo, then Wikipedia.'] },
  { id: 'ask.about', help: ['hubot tell me about'] },
  { id: 'rules.show', help: ['hubot the rules'] },
  { id: 'diagnostics.ping', help: ['hubot ping'] }
]

const ALLOWED_IDS = new Set(ALLOWED.map(a => a.id))

// external listeners can't take ids, matched on their respond pattern
const EXTERNAL: [string, string][] = [
  ['(what are )?the (three |3 )?(rules|laws)', 'rules.show'],
  ['PING$', 'diagnostics.ping']
]

export const MAX_TEXT = 500
const TIMEOUT_MS = 60 * 1000
const SETTLE_MS = 50
const WINDOW_MS = 60 * 1000
const MAX_PER_WINDOW = 10
const BASE_COOLDOWN_MS = 30 * 1000
const MAX_COOLDOWN_MS = 30 * 60 * 1000
const MAX_IN_FLIGHT = 4
const DAY_MS = 24 * 60 * 60 * 1000

// per process, so visitor ids never map back to an ip
const SALT = randomBytes(16)

const escapeRegExp = (str: string): string => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

interface Visitor {
  hits: number[]
  until: number
  offenses: number
  busy: boolean
  seen: number
}

interface ListenerLike {
  options?: { id?: string | null }
  regex?: RegExp
}

interface Req {
  body?: { text?: unknown }
  headers: Record<string, string | string[] | undefined>
  socket?: { remoteAddress?: string }
}

interface Res {
  status(code: number): Res
  set(name: string, value: string): Res
  json(body: unknown): void
  send(body: string): void
  type(t: string): Res
}

export default async (robot: Robot) => {
  const page = readFileSync(new URL('../public/chat.html', import.meta.url), 'utf8')
  const visitors = new Map<string, Visitor>()
  const collectors = new Map<string, string[]>()
  let inFlight = 0

  const listenerId = (listener: ListenerLike): string | null => {
    const id = listener.options?.id
    if (id) return id
    const source = listener.regex?.source ?? ''
    return EXTERNAL.find(([tail]) => source.endsWith(`(?:${tail})`))?.[1] ?? null
  }

  const visitorFor = (key: string, now: number): Visitor => {
    let v = visitors.get(key)
    if (!v) {
      v = { hits: [], until: 0, offenses: 0, busy: false, seen: now }
      visitors.set(key, v)
    }
    v.seen = now
    return v
  }

  // forget idle visitors
  const prune = (now: number): void => {
    for (const [key, v] of visitors) {
      if (!v.busy && now - v.seen > DAY_MS && now > v.until) visitors.delete(key)
    }
  }

  const gate = async ({ listener, response }: ListenerMiddlewareContext): Promise<boolean> => {
    const room = response.message.room
    if (!isWebRoom(room)) return true
    // hubot runs the listener when middleware throws
    try {
      const id = listenerId(listener as ListenerLike)
      return Boolean(id && ALLOWED_IDS.has(id))
    } catch (err) {
      robot.logger.error(`web chat gate: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  robot.listenerMiddleware(gate)
  // ahead of other middleware, a throw there would skip the gate
  const stack = (robot as unknown as { middleware: { listener: { stack: unknown[] } } }).middleware.listener.stack
  stack.unshift(stack.pop())

  robot.responseMiddleware(async ({ response, strings }) => {
    const room = (response.envelope as { room?: string } | undefined)?.room
    if (!isWebRoom(room)) return true
    collectors.get(room!)?.push(strings.join(''))
    return false
  })

  // anything else aimed at a web room, e.g. messageRoom
  const send = robot.adapter.send.bind(robot.adapter)
  robot.adapter.send = async (envelope, ...strings) => {
    if (isWebRoom(envelope?.room)) {
      collectors.get(envelope.room!)?.push(strings.join(''))
      return
    }
    return send(envelope, ...strings)
  }

  const helpText = (): string => {
    const prefixes = ALLOWED.flatMap(a => a.help)
    const scraped = robot.helpCommands().filter(line => prefixes.some(p => line.startsWith(p)))
    return [...scraped, ...ALLOWED.flatMap(a => a.lines ?? [])]
      .sort()
      .map(line => line.replace(/^hubot/, robot.name))
      .join('\n')
  }

  const botName = new RegExp(`^@?(?:${[robot.name, robot.alias].filter(Boolean).map(n => escapeRegExp(n!)).join('|')})[:,]?\\s+`, 'i')

  robot.router.get('/chat', (_req: Req, res: Res) => {
    const nonce = randomBytes(16).toString('base64')
    res.set('Content-Security-Policy', `default-src 'self'; img-src https:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`)
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Referrer-Policy', 'no-referrer')
    // fresh nonce per load, no edge caching
    res.set('Cache-Control', 'no-store')
    res.type('html').send(page.replaceAll('{{name}}', robot.name).replaceAll('{{nonce}}', nonce))
  })

  robot.router.post('/chat/send', async (req: Req, res: Res) => {
    const raw = req.body?.text
    if (typeof raw !== 'string') return res.status(400).json({ error: 'text is required' })
    const text = raw.replace(/\s+/g, ' ').trim().replace(botName, '')
    if (text.length === 0 || text.length > MAX_TEXT) return res.status(400).json({ error: `keep it between 1 and ${MAX_TEXT} characters` })

    // only nginx can reach the port, it sets x-real-ip
    const header = req.headers['x-real-ip']
    const ip = (Array.isArray(header) ? header[0] : header) || req.socket?.remoteAddress || 'unknown'
    const key = createHash('sha256').update(SALT).update(ip).digest('hex').slice(0, 16)
    const now = Date.now()
    prune(now)
    const v = visitorFor(key, now)

    if (now < v.until) {
      res.set('Retry-After', String(Math.ceil((v.until - now) / 1000)))
      return res.status(429).json({ error: 'slow down' })
    }
    v.hits = v.hits.filter(t => now - t < WINDOW_MS)
    v.hits.push(now)
    if (v.hits.length > MAX_PER_WINDOW) {
      v.offenses++
      v.until = now + Math.min(BASE_COOLDOWN_MS * 2 ** (v.offenses - 1), MAX_COOLDOWN_MS)
      v.hits = []
      res.set('Retry-After', String(Math.ceil((v.until - now) / 1000)))
      return res.status(429).json({ error: 'slow down' })
    }

    if (/^help\??$/i.test(text)) return res.json({ replies: [helpText()] })

    if (v.busy) return res.status(429).json({ error: 'one message at a time' })
    if (inFlight >= MAX_IN_FLIGHT) return res.status(503).json({ error: 'busy, try again in a moment' })

    const room = `${WEB_PREFIX}${key}`
    const replies: string[] = []
    collectors.set(room, replies)
    v.busy = true
    inFlight++
    let timer: NodeJS.Timeout | undefined
    try {
      // not stored in the brain
      const user = new User(room, { name: 'guest', room })
      const message = new TextMessage(user, `${robot.name} ${text}`, randomUUID())
      await Promise.race([
        robot.receive(message),
        new Promise(resolve => { timer = setTimeout(resolve, TIMEOUT_MS) })
      ])
      // un-awaited sends, e.g. hubot-rules
      await new Promise(resolve => setTimeout(resolve, SETTLE_MS))
    } catch (err) {
      robot.logger.error(`web chat: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      clearTimeout(timer)
      collectors.delete(room)
      v.busy = false
      inFlight--
    }
    res.json({ replies })
  })
}
