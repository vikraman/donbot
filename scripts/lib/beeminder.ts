import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'

import { formatDuration } from './duration.ts'
import { formatWhen, fromZoned, MINUTE_MS, HOUR_MS, zonedParts } from './time.ts'

const API = 'https://www.beeminder.com/api/v1'

export interface Goal {
  slug: string
  title?: string
  // unix seconds
  losedate: number
  safebuf: number
  roadstatuscolor?: string
  colorkey?: string
  baremin?: string
  limsum?: string
  rate?: number | null
  runits?: string
  gunits?: string
  gunits_singular?: string
  hhmmformat?: boolean
  secret?: boolean
  won?: boolean
  lost?: boolean
  frozen?: boolean
  // iso time of the last data change
  lasttouch?: string
}

export interface Datapoint {
  timestamp: number
  value: number
  comment?: string
  created_at?: string
  updated_at?: number
}

export interface Me {
  username: string
  timezone?: string
}

export interface BeeResponse<T> {
  status: number
  body?: T
}

export interface BeeClient {
  me: () => Promise<BeeResponse<Me>>
  goals: (user: string) => Promise<BeeResponse<Goal[]>>
  datapoints: (user: string, slug: string, count: number) => Promise<BeeResponse<Datapoint[]>>
}

export const beeminderClient = (token: string): BeeClient => {
  const get = async <T>(path: string, query: Record<string, string> = {}): Promise<BeeResponse<T>> => {
    const params = new URLSearchParams({ ...query, auth_token: token })
    const res = await fetch(`${API}${path}?${params}`, { headers: { 'User-Agent': 'donbot' } })
    return { status: res.status, body: res.status === 200 ? await res.json() as T : undefined }
  }
  return {
    me: () => get<Me>('/users/me.json'),
    goals: user => get<Goal[]>(`/users/${encodeURIComponent(user)}/goals.json`),
    datapoints: (user, slug, count) => get<Datapoint[]>(`/users/${encodeURIComponent(user)}/goals/${encodeURIComponent(slug)}/datapoints.json`, { sort: 'timestamp', count: String(count) })
  }
}

export const TOKEN_RE = /^[\w-]{8,64}$/

// 32 bytes as base64, or any passphrase hashed down to 32
const tokenKey = (): Buffer | undefined => {
  const raw = process.env.BEEMINDER_TOKEN_KEY
  if (!raw) return undefined
  const decoded = Buffer.from(raw, 'base64')
  return decoded.length === 32 ? decoded : createHash('sha256').update(raw).digest()
}

export const canSeal = (): boolean => tokenKey() !== undefined

// aes-256-gcm, v1:iv:tag:ciphertext
export const sealToken = (token: string): string => {
  const key = tokenKey()
  if (!key) throw new Error('BEEMINDER_TOKEN_KEY is not set')
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return ['v1', iv, cipher.getAuthTag(), ct].map(p => typeof p === 'string' ? p : p.toString('base64')).join(':')
}

// undefined when the key is missing, changed, or the blob is tampered with
export const openToken = (sealed: unknown): string | undefined => {
  const key = tokenKey()
  if (!key || typeof sealed !== 'string') return undefined
  const [v, iv, tag, ct] = sealed.split(':')
  if (v !== 'v1' || !iv || !tag || !ct) return undefined
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
    decipher.setAuthTag(Buffer.from(tag, 'base64'))
    return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8')
  } catch {
    return undefined
  }
}

export const COLORS = ['red', 'orange', 'blue', 'green', 'gray'] as const
export type Color = typeof COLORS[number]

export const COLOR_EMOJI: Record<Color, string> = { red: '🔴', orange: '🟠', blue: '🔵', green: '🟢', gray: '⚪' }

// beeminder's own color, else the safe-days rule it is based on
export const colorOf = (goal: Goal): Color => {
  const raw = (goal.roadstatuscolor ?? goal.colorkey ?? '').toLowerCase()
  if (raw === 'dkgreen' || raw === 'darkgreen') return 'green'
  if ((COLORS as readonly string[]).includes(raw)) return raw as Color
  if (goal.safebuf < 1) return 'red'
  if (goal.safebuf < 2) return 'orange'
  if (goal.safebuf < 3) return 'blue'
  return goal.safebuf < 7 ? 'green' : 'gray'
}

export const loseMs = (goal: Goal): number => goal.losedate * 1000

export const touchedMs = (goal: Goal): number | undefined => {
  const ms = goal.lasttouch ? Date.parse(goal.lasttouch) : NaN
  return Number.isFinite(ms) ? ms : undefined
}

// beeminder adds "#DERAIL ON THE 14th" some hours after the deadline
export const DERAIL_COMMENT = /#?derail/i

export const createdMs = (point: Datapoint): number => {
  const ms = point.created_at ? Date.parse(point.created_at) : NaN
  return Number.isFinite(ms) ? ms : (point.updated_at ?? 0) * 1000
}

// how often to look for the derail datapoint, and for how long
export const DERAIL_CHECK_MS = 30 * MINUTE_MS
export const DERAIL_WAIT_MS = 24 * HOUR_MS

export const byUrgency = (a: Goal, b: Goal): number => a.losedate - b.losedate

// " pushups", singular for ±1; none for hh:mm amounts
export const unitsFor = (goal: Goal, amount: string): string => {
  if (!goal.gunits || goal.hhmmformat || amount.includes(':')) return ''
  return ` ${Math.abs(Number(amount)) === 1 ? goal.gunits_singular || goal.gunits : goal.gunits}`
}

// "+3 pushups by today at 11:59pm"
export const needText = (goal: Goal, tz: string, now = Date.now()): string => {
  const when = formatWhen(loseMs(goal), tz, now)
  return goal.baremin ? `${goal.baremin}${unitsFor(goal, goal.baremin)} by ${when}` : `${goal.limsum ?? 'derails'} (${when})`
}

export const timeLeft = (goal: Goal, now = Date.now()): string =>
  formatDuration(loseMs(goal) - now, { round: Math.ceil })

export const goalUrl = (user: string, slug: string): string => `https://www.beeminder.com/${user}/${slug}`

export const ZENO_START_MS = 8 * HOUR_MS
export const ZENO_FLOOR_MS = 5 * MINUTE_MS

// alert times before a deadline, each gap half the last: 8h, 4h, 2h, ...
export const zenoTimes = (lose: number, startMs = ZENO_START_MS, floorMs = ZENO_FLOOR_MS): number[] => {
  const times: number[] = []
  for (let before = startMs; before >= floorMs; before /= 2) times.push(lose - before)
  return times
}

// index of the latest alert time that has passed, -1 for none or after the deadline
export const dueZenoStep = (now: number, lose: number, startMs = ZENO_START_MS, floorMs = ZENO_FLOOR_MS): number => {
  if (now >= lose) return -1
  return zenoTimes(lose, startMs, floorMs).findLastIndex(t => t <= now)
}

// a goal turns red a day before it derails, by the user's wall clock
export const turnsRedAt = (lose: number, tz: string): number => {
  const p = zonedParts(lose, tz)
  return fromZoned(p.year, p.month, p.day - 1, p.hour, p.minute, tz)
}

export interface Quiet {
  start: number
  end: number
}

export const QUIET: Quiet = { start: 1, end: 8 }

// "1-8", hours in the user's tz; "off" disables
export const parseQuiet = (text: string | undefined): Quiet | undefined => {
  if (!text) return QUIET
  if (/^(off|none)$/i.test(text.trim())) return undefined
  const m = text.trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/)
  if (!m) return QUIET
  const start = Number(m[1])
  const end = Number(m[2])
  return start < 24 && end < 24 && start !== end ? { start, end } : QUIET
}

export const isQuiet = (now: number, tz: string, quiet: Quiet | undefined): boolean => {
  if (!quiet) return false
  const { hour } = zonedParts(now, tz)
  return quiet.start < quiet.end ? hour >= quiet.start && hour < quiet.end : hour >= quiet.start || hour < quiet.end
}

// next end of quiet hours after now
export const quietEnd = (now: number, tz: string, quiet: Quiet): number => {
  const p = zonedParts(now, tz)
  const today = fromZoned(p.year, p.month, p.day, quiet.end, 0, tz)
  return today > now ? today : fromZoned(p.year, p.month, p.day + 1, quiet.end, 0, tz)
}

export interface PollOptions {
  maxMs: number
  zenoStartMs?: number
  zenoFloorMs?: number
}

// soonest moment worth looking again: a zeno alert, a deadline, a goal turning red, or the cap
export const nextPollAt = (goals: Goal[], now: number, tz: string, { maxMs, zenoStartMs = ZENO_START_MS, zenoFloorMs = ZENO_FLOOR_MS }: PollOptions): number => {
  let next = now + maxMs
  for (const goal of goals) {
    if (goal.won || goal.frozen) continue
    const lose = loseMs(goal)
    if (lose <= now) {
      // derail pending
      next = Math.min(next, now + DERAIL_CHECK_MS)
      continue
    }
    // just after the deadline, to see a derail
    next = Math.min(next, lose + 2 * MINUTE_MS)
    const zeno = zenoTimes(lose, zenoStartMs, zenoFloorMs).find(t => t > now)
    if (zeno !== undefined && colorOf(goal) === 'red') next = Math.min(next, zeno)
    const red = turnsRedAt(lose, tz) + MINUTE_MS
    if (red > now) next = Math.min(next, red)
  }
  return Math.max(next, now + MINUTE_MS)
}
