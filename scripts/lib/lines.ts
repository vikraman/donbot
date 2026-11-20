import type { Robot } from 'hubot'

import { defineFeature } from './features.ts'
import { GeminiError, geminiText } from './gemini.ts'
import { chance, randomBelow } from './random.ts'
import { zonedParts } from './time.ts'
import { defaultTz } from './timezone.ts'

// varied bot lines: no-repeat bags, composed parts, context flair, rare surprises,
// gemini-written lines kept in reserve, and reactions that retire or keep lines

type Lines = readonly string[]

defineFeature({ id: 'lines.extras', label: 'Playful lines', level: 'casual' })
defineFeature({ id: 'lines.ai', label: 'AI-written lines', level: 'casual' })

// composed as open + body + close; '' entries mean "skip this part"
export interface Parts {
  open?: Lines
  body: Lines
  close?: Lines
}

export interface LineSpec {
  fallback: Lines | Parts
  // ~1 in 50, when set
  rare?: Lines
  // appends a time-of-week remark now and then
  flair?: boolean
  // gemini refills a reserve of fresh lines for this kind
  ai?: { about: string, slots?: readonly string[] }
  // lines for professional rooms
  professional?: Lines | Parts
  // gating feature, default lines.extras
  feature?: string
}

export type Vars = Record<string, string | number | undefined>

export interface LineOptions {
  room?: string
  tz?: string
}

export type LineFn = (vars?: Vars, options?: LineOptions) => string

export const RARE_CHANCE = 0.02
export const FLAIR_CHANCE = 0.2
// share of picks served from the ai reserve when it has stock
export const AI_SHARE = 0.5
export const AI_POOL_SIZE = 30
export const AI_LOW_WATER = 10
// free tier: refill each kind rarely, cap requests per day, one refill at a time
export const AI_REFILL_INTERVAL_MS = 6 * 60 * 60 * 1000
export const AI_DAILY_CALLS = 20
export const AI_RETRY_MS = 30 * 60 * 1000
// overloaded models usually recover quickly
export const AI_BUSY_RETRY_MS = 15 * 60 * 1000
// 429 means a quota ran out
export const AI_QUOTA_RETRY_MS = 2 * 60 * 60 * 1000

const dailyCalls = (): number => Number(process.env.GEMINI_LINE_DAILY_CALLS) || AI_DAILY_CALLS
export const AI_MAX_LENGTH = 180
// lines scored at or below this are mostly skipped
export const RETIRE_SCORE = -2
// ai lines scored at or above this join the kind's static lines
export const KEEP_SCORE = 2
const RECENT_LIMIT = 300

interface Bag {
  sig: string
  order: number[]
  last?: number
}

interface Pool {
  lines: string[]
  // no refill attempts before this
  nextAt?: number
}

interface Budget {
  day: string
  calls: number
}

export interface LineRef {
  kind: string
  template: string
  source: 'static' | 'rare' | 'ai' | 'kept' | 'flair'
}

const specs = new Map<string, LineSpec>()
// rendered text -> where it came from, for reaction feedback
const recent = new Map<string, LineRef>()
const memory = new Map<string, unknown>()
const refilling = new Set<string>()

let linesRobot: Robot | null = null
let extras = true
// set by Policy.ts; no room means professional
let casualAllowed: (room: string | undefined, feature: string) => boolean = () => true

// call once at startup so bags, scores and reserves persist
export const useLines = (robot: Robot) => { linesRobot = robot }

// tests turn off chance-based extras so picks stay deterministic
export const configureLines = (options: { extras?: boolean, casual?: (room: string | undefined, feature: string) => boolean }) => {
  if (options.extras !== undefined) extras = options.extras
  if (options.casual) casualAllowed = options.casual
}

export const resetLines = () => {
  linesRobot = null
  memory.clear()
  recent.clear()
  refilling.clear()
}

const load = <T>(key: string): T | undefined => {
  const value = linesRobot ? linesRobot.brain.get(key) : memory.get(key)
  return value === null ? undefined : value as T | undefined
}

const save = (key: string, value: unknown) => {
  if (linesRobot) linesRobot.brain.set(key, value)
  else memory.set(key, value)
}

const scoreKey = (kind: string): string => `lines:score:${kind}`
const keptKey = (kind: string): string => `lines:kept:${kind}`
const poolKey = (kind: string): string => `lines:ai:${kind}`

export const scoresFor = (kind: string): Record<string, number> => load<Record<string, number>>(scoreKey(kind)) ?? {}
export const keptFor = (kind: string): string[] => load<string[]>(keptKey(kind)) ?? []
export const poolFor = (kind: string): Pool => {
  const stored = load<Pool>(poolKey(kind))
  return stored && Array.isArray(stored.lines) ? stored : { lines: [] }
}

const BUDGET_KEY = 'lines:ai:budget'

export const aiCallsToday = (): number => {
  const budget = load<Budget>(BUDGET_KEY)
  return budget?.day === new Date().toISOString().slice(0, 10) ? budget.calls : 0
}

// counts one request against today's cap; false when it's used up
const spendCall = (): boolean => {
  const calls = aiCallsToday()
  if (calls >= dailyCalls()) return false
  save(BUDGET_KEY, { day: new Date().toISOString().slice(0, 10), calls: calls + 1 })
  return true
}

const signature = (items: Lines): string => `${items.length}:${items.map(s => s.slice(0, 8)).join('|')}`

// forward fisher-yates, so a zero source keeps list order
const shuffledIndexes = (n: number): number[] => {
  const order = Array.from({ length: n }, (_, i) => i)
  for (let i = 0; i < n - 1; i++) {
    const j = i + randomBelow(n - i)
    ;[order[i], order[j]] = [order[j]!, order[i]!]
  }
  return order
}

// every item once, in a random order, before any repeats
const drawFromBag = (key: string, items: Lines, scores: Record<string, number> = {}): string | undefined => {
  if (items.length === 0) return undefined
  if (items.length === 1) return items[0]
  const bagKey = `lines:bag:${key}`
  const sig = signature(items)
  let bag = load<Bag>(bagKey)
  if (!bag || bag.sig !== sig || !Array.isArray(bag.order)) bag = { sig, order: [] }
  // a few tries to skip retired lines
  for (let attempt = 0; attempt < items.length + 1; attempt++) {
    if (bag.order.length === 0) {
      bag.order = shuffledIndexes(items.length)
      // no repeat across the reshuffle seam
      if (bag.order[0] === bag.last) bag.order.push(bag.order.shift()!)
    }
    const index = bag.order.shift()!
    const item = items[index]!
    bag.last = index
    if ((scores[item] ?? 0) <= RETIRE_SCORE && chance(0.75)) continue
    save(bagKey, bag)
    return item
  }
  save(bagKey, bag)
  return items[bag.last ?? 0]
}

// plain list helper for scripts that just want no-repeat picks
export const bagPick = (key: string, items: Lines): string | undefined => drawFromBag(key, items)

const fill = (template: string, vars: Vars): string =>
  template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = vars[name]
    return value === undefined ? whole : String(value)
  })

const DAYPARTS = ['night', 'night', 'night', 'night', 'night', 'early morning', 'early morning', 'early morning', 'morning', 'morning', 'morning', 'morning', 'afternoon', 'afternoon', 'afternoon', 'afternoon', 'afternoon', 'evening', 'evening', 'evening', 'evening', 'evening', 'night', 'night'] as const
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const

export const contextVars = (tz: string, now = Date.now()): Vars => {
  const p = zonedParts(now, tz)
  // 2am monday is still sunday night
  const weekday = p.hour < 5 ? zonedParts(now - 5 * 60 * 60 * 1000, tz).weekday : p.weekday
  return { daypart: DAYPARTS[p.hour], weekday: WEEKDAYS[weekday] }
}

const FLAIR: Record<string, Lines> = {
  mondayMorning: ['Strong start to the week.', 'Monday, handled.', 'Look at you, Monday-ing.', 'The week never saw it coming.'],
  fridayAfternoon: ['Friday energy! 🎉', 'Nearly the weekend.', 'A fine way to close out the week.', 'Friday-afternoon heroics, noted.'],
  lateNight: ['Also: go to bed. 🌙', 'Night owl mode. 🦉', 'The moon is impressed.', 'Burning the midnight oil, I see.'],
  weekend: ['On a weekend, no less.', 'Weekend warrior. ⚔️', 'Even the weekend bows to you.'],
  earlyMorning: ['Early bird! 🐦', 'Before most people have had coffee.', 'The sun is barely up and neither is anyone else.']
}

const situationOf = (tz: string, now = Date.now()): keyof typeof FLAIR | undefined => {
  const { hour, weekday } = zonedParts(now, tz)
  if (hour >= 23 || hour < 5) return 'lateNight'
  if (weekday === 0 || weekday === 6) return 'weekend'
  if (hour < 8) return 'earlyMorning'
  if (weekday === 1 && hour < 12) return 'mondayMorning'
  if (weekday === 5 && hour >= 13) return 'fridayAfternoon'
  return undefined
}

const remember = (text: string, ref: LineRef) => {
  recent.delete(text)
  recent.set(text, ref)
  while (recent.size > RECENT_LIMIT) recent.delete(recent.keys().next().value!)
}

// which generated lines a bot message contains
export const linesIn = (content: string): LineRef[] => {
  const found: LineRef[] = []
  for (const [text, ref] of recent) if (text && content.includes(text)) found.push(ref)
  return found
}

const PLACEHOLDER = /\{(\w+)\}/g

// keeps only safe, on-brief lines
export const validAiLine = (line: unknown, slots: readonly string[]): line is string => {
  if (typeof line !== 'string') return false
  const text = line.trim()
  if (!text || text.length > AI_MAX_LENGTH || /\n|https?:|@everyone|@here|<@|#\w/.test(text)) return false
  const used = [...text.matchAll(PLACEHOLDER)].map(m => m[1]!)
  return used.every(u => slots.includes(u)) && slots.every(s => text.includes(`{${s}}`))
}

const VOICE = [
  'You write lines for donbot, a friendly, dry-witted Discord bot for a small group of researchers and programmers.',
  'Tone: warm, playful, a little absurd, never mean, never corporate, no exclamation-mark spam.',
  'Each line is original: no quotes from films, TV, books or songs, no catchphrases from existing characters.',
  'Plain text, at most one emoji, no hashtags, no links, no mentions.'
].join(' ')

const retryAfter = (error: unknown): number => {
  const status = error instanceof GeminiError ? error.status : 0
  if (status === 429) return AI_QUOTA_RETRY_MS
  if (status === 503) return AI_BUSY_RETRY_MS
  return AI_RETRY_MS
}

const generate = async (kind: string, spec: LineSpec, count: number): Promise<string[]> => {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey || !spec.ai) return []
  const slots = spec.ai.slots ?? []
  const examples = (Array.isArray(spec.fallback) ? spec.fallback : (spec.fallback as Parts).body).slice(0, 4)
  const prompt = [
    `Write ${count} different one-line messages: ${spec.ai.about}.`,
    slots.length ? `Every line must contain ${slots.map(s => `{${s}}`).join(' and ')} exactly where that value belongs, and no other {placeholders}.` : 'Use no {placeholders}.',
    `Keep each under ${AI_MAX_LENGTH} characters. Vary structure and length; avoid starting lines the same way.`,
    `For flavour only (do not copy): ${examples.map(e => JSON.stringify(e)).join(', ')}.`,
    'Return only a JSON array of strings.'
  ].join(' ')
  const text = await geminiText({
    contents: [{ parts: [{ text: prompt }] }],
    systemInstruction: { parts: [{ text: VOICE }] },
    generationConfig: { responseMimeType: 'application/json', temperature: 1.1, maxOutputTokens: 4096 }
  }, { beforeCall: spendCall, warn: m => linesRobot?.logger.warn(`lines: ${m}`) }) ?? '[]'
  const parsed: unknown = JSON.parse(text)
  if (!Array.isArray(parsed)) throw new Error(`gemini returned ${typeof parsed} for ${kind}`)
  return parsed.filter((l): l is string => validAiLine(l, slots)).map(l => l.trim())
}

// fire-and-forget; resolves when done, for tests and the refill command
// force skips the per-kind interval, never the daily cap
export const refillAi = async (kind: string, { force = false } = {}): Promise<number> => {
  const spec = specs.get(kind)
  if (!spec?.ai || !process.env.GEMINI_API_KEY || refilling.size > 0) return 0
  const pool = poolFor(kind)
  if (!force && Date.now() < (pool.nextAt ?? 0)) return 0
  const wanted = AI_POOL_SIZE - pool.lines.length
  if (wanted < 1) return 0
  refilling.add(kind)
  try {
    const fresh = await generate(kind, spec, Math.min(wanted, 20))
    const current = poolFor(kind)
    const seen = new Set([...current.lines, ...keptFor(kind)])
    const added = [...new Set(fresh)].filter(l => !seen.has(l))
    save(poolKey(kind), { lines: [...current.lines, ...added].slice(0, AI_POOL_SIZE), nextAt: Date.now() + AI_REFILL_INTERVAL_MS })
    return added.length
  } catch (error) {
    linesRobot?.logger.warn(`lines: ai refill for ${kind} failed: ${String(error)}`)
    const retryMs = retryAfter(error)
    save(poolKey(kind), { ...poolFor(kind), nextAt: Date.now() + retryMs })
    return 0
  } finally {
    refilling.delete(kind)
  }
}

const takeAi = (kind: string): string | undefined => {
  const pool = poolFor(kind)
  const index = pool.lines.length ? randomBelow(pool.lines.length) : -1
  const line = pool.lines[index]
  if (line !== undefined) save(poolKey(kind), { ...pool, lines: pool.lines.filter((_, i) => i !== index) })
  if (pool.lines.length - 1 <= AI_LOW_WATER) void refillAi(kind)
  return line
}

// kept lines are ai-written
const pickStatic = (kind: string, spec: LineSpec, withKept = true): { template: string, source: LineRef['source'] } => {
  const scores = scoresFor(kind)
  const kept = withKept ? keptFor(kind) : []
  if (Array.isArray(spec.fallback)) {
    const items = [...spec.fallback as Lines, ...kept]
    const template = drawFromBag(kind, items, scores) ?? ''
    return { template, source: kept.includes(template) ? 'kept' : 'static' }
  }
  const parts = spec.fallback as Parts
  const body = [...parts.body, ...kept]
  const middle = drawFromBag(`${kind}:body`, body, scores) ?? ''
  // kept ai lines are whole sentences, so no extra parts
  if (kept.includes(middle)) return { template: middle, source: 'kept' }
  const open = parts.open ? drawFromBag(`${kind}:open`, parts.open) ?? '' : ''
  const close = parts.close ? drawFromBag(`${kind}:close`, parts.close) ?? '' : ''
  return { template: [open, middle, close].filter(Boolean).join(' '), source: 'static' }
}

// registers a kind and returns its renderer
export const defineLines = (kind: string, spec: LineSpec): LineFn => {
  specs.set(kind, spec)
  return (vars = {}, { room, tz = defaultTz() }: LineOptions = {}) => {
    const all = { ...contextVars(tz), ...vars }
    const casual = casualAllowed(room, spec.feature ?? 'lines.extras')
    if (!casual) {
      const pro = spec.professional
      const proKind = pro ? `${kind}:pro` : kind
      const { template, source } = pickStatic(proKind, pro ? { fallback: pro } : spec, false)
      const text = fill(template, all)
      // score the pro list
      remember(text, { kind: proKind, template, source })
      return text
    }
    const aiOk = extras && spec.ai && casualAllowed(room, 'lines.ai')
    let template: string
    let source: LineRef['source']
    if (extras && spec.rare?.length && chance(RARE_CHANCE)) {
      template = drawFromBag(`${kind}:rare`, spec.rare) ?? ''
      source = 'rare'
    } else {
      const ai = aiOk && chance(AI_SHARE) ? takeAi(kind) : undefined
      if (ai) {
        template = ai
        source = 'ai'
      } else {
        // no kept ai lines where ai is off
        ;({ template, source } = pickStatic(kind, spec, casualAllowed(room, 'lines.ai')))
        // keeps the reserve topped up even before the first ai pick
        if (aiOk && poolFor(kind).lines.length <= AI_LOW_WATER) void refillAi(kind)
      }
    }
    const text = fill(template, all)
    remember(text, { kind, template, source })
    const situation = extras && spec.flair && chance(FLAIR_CHANCE) ? situationOf(tz) : undefined
    if (!situation) return text
    const flair = drawFromBag(`flair:${situation}`, FLAIR[situation]!) ?? ''
    return `${text} ${flair}`
  }
}

// one reaction's worth of feedback; good ai lines become permanent, bad ones fade
export const scoreLine = (ref: LineRef, delta: number) => {
  if (ref.source === 'flair') return
  const scores = { ...scoresFor(ref.kind) }
  const score = (scores[ref.template] ?? 0) + delta
  scores[ref.template] = score
  save(scoreKey(ref.kind), scores)
  if (ref.source === 'ai' && score >= KEEP_SCORE) {
    const kept = keptFor(ref.kind)
    if (!kept.includes(ref.template)) save(keptKey(ref.kind), [...kept, ref.template])
  }
  if (ref.source === 'kept' && score <= RETIRE_SCORE) {
    save(keptKey(ref.kind), keptFor(ref.kind).filter(l => l !== ref.template))
  }
}

export const lineKinds = (): string[] => [...specs.keys()].sort()

export const aiKinds = (): string[] => lineKinds().filter(k => specs.get(k)?.ai)
