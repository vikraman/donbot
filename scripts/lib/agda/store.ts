import { readFile } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { Readable } from 'node:stream'
import { createGunzip } from 'node:zlib'
import { createClient } from 'redis'

import { ascii, hash, segmentRuns } from './fold.ts'
import { consts, decode, encode, encodeTyping, headId, inlineOf, isSortName, normalise, size, type NameInfo, type Term, type Typing } from './term.ts'
import type { El, Env, Notation } from './parse.ts'
import { canonicaliser, type Template } from './canon.ts'
import { setSuc } from './unify.ts'

// redis search index

export interface Library {
  name: string
  commit: string
  url: string
  // indexed sources
  source: string
  agda: string
  // indexer build
  build?: string
  count: number
  format: number
  gen: string
  // builtin zero and suc ids
  zero?: string
  suc?: string
}

interface State {
  // in source order
  libs: Library[]
  // live generations clause
  live: string
  scopes: Map<string, Scope>
  nat: { zero: Set<string>, suc: Set<string> }
  // across libraries
  rigid: Set<string>
  // per-generation caches
  caches: Map<string, unknown>
}

// parse context per library
export interface Scope {
  // notation parts
  parts: Set<string>
  // type letters
  concrete: Set<string>
  // primitive aliases
  templates: Template[]
}

// schema version
const SCHEMA_VERSION = '11'

const prefix = (): string => process.env.AGDA_REDIS_PREFIX || 'agda'
const url = (): string | undefined => process.env.REDIS_URL || process.env.REDISTOGO_URL || process.env.REDISCLOUD_URL || process.env.BOXEN_REDIS_URL

let client: ReturnType<typeof createClient> | null = null
let connecting: Promise<ReturnType<typeof createClient>> | null = null
let state: State | null = null

const redis = async () => {
  if (client) return client
  connecting ??= (async () => {
    const at = url()
    if (!at) throw new Error('no REDIS_URL for the index')
    const c = createClient({ url: at, socket: { connectTimeout: 5000, reconnectStrategy: n => (n > 30 ? new Error('redis unreachable') : Math.min(n * 200, 5000)) } })
    c.on('error', () => {})
    // unref idle connections
    c.unref()
    await c.connect()
    // compact documents
    await c.sendCommand(['CONFIG', 'SET', 'search-max-prefix-expansions', '1000000', 'hash-max-listpack-value', '8192']).catch(() => {})
    client = c
    return c
  })().finally(() => {
    connecting = null
  })
  return connecting
}

export const cmd = async <T = unknown>(args: string[]): Promise<T> => (await redis()).sendCommand<T>(args)

export const closeStore = async (): Promise<void> => {
  const c = client
  client = null
  state = null
  if (c) await c.quit().catch(() => {})
}

export const libraries = (): Library[] => state?.libs ?? []
export const indexSize = (): number => libraries().reduce((n, l) => n + l.count, 0)

const index = (): string => prefix()
const metaKey = (): string => `${prefix()}:meta`
const docPrefix = (lib: string, gen: string): string => `${prefix()}:d:${lib}:${gen}:`
const libKey = (kind: string, lib: string, gen: string): string => `${prefix()}:${kind}:${lib}:${gen}`
const genTag = (lib: string, gen: string): string => `${lib}:${gen}`
// written generations
const gensKey = (): string => `${prefix()}:gens`

// escaped tag values
export const tag = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, ch => (ch.charCodeAt(0) < 128 ? `\\${ch}` : ch))

export const tags = (field: string, values: Iterable<string>): string => `@${field}:{${[...values].map(tag).join('|')}}`

const readMeta = async (): Promise<{ libs: Library[], schema: string | null }> => {
  const raw = await cmd<string[]>(['HGETALL', metaKey()])
  const m = new Map<string, string>()
  for (let i = 0; i + 1 < raw.length; i += 2) m.set(raw[i]!, raw[i + 1]!)
  const order = JSON.parse(m.get('order') ?? '[]') as string[]
  const libs = order.flatMap(n => (m.has(`lib:${n}`) ? [JSON.parse(m.get(`lib:${n}`)!) as Library] : []))
  return { libs, schema: m.get('schema') ?? null }
}

// read published state, queued
export const refresh = (): Promise<boolean> => {
  const next = queue.then(() => refreshNow())
  queue = next.catch(() => {})
  return next
}

const refreshNow = async (): Promise<boolean> => {
  const { libs, schema } = await readMeta()
  if (schema !== SCHEMA_VERSION || libs.length === 0) {
    state = null
    return false
  }
  const key = libs.map(l => genTag(l.name, l.gen)).join(',')
  if (state && state.libs.map(l => genTag(l.name, l.gen)).join(',') === key) {
    state = { ...state, libs }
    return true
  }
  const scopes = new Map<string, Scope>()
  const rigid = new Set<string>()
  for (const l of libs) {
    for (const r of await cmd<string[]>(['SMEMBERS', libKey('rigid', l.name, l.gen)])) rigid.add(r)
    const parts = new Set(await cmd<string[]>(['HKEYS', libKey('parts', l.name, l.gen)]))
    const concrete = new Set(await cmd<string[]>(['SMEMBERS', libKey('concrete', l.name, l.gen)]))
    const templates = JSON.parse((await cmd<string | null>(['GET', libKey('templates', l.name, l.gen)])) ?? '[]') as Template[]
    scopes.set(l.name, { parts, concrete, templates })
  }
  const nat = { zero: new Set(libs.flatMap(l => (l.zero ? [l.zero] : []))), suc: new Set(libs.flatMap(l => (l.suc ? [l.suc] : []))) }
  setSuc(nat.suc)
  state = { libs, live: tags('gen', libs.map(l => genTag(l.name, l.gen))), scopes, nat, rigid, caches: new Map() }
  return true
}

// documents

export type Doc = Record<string, string>

export const FIELDS = ['n', 'm', 'f', 'k', 't', 'j', 'u', 'y', 'uy', 'l', 'p', 'c', 'a', 'lib', 'size', 'refs', 'consts']

// ft.search over live generations
export const search = async (query: string, opts: { offset?: number, limit?: number, sortBy?: string, fields?: string[] } = {}): Promise<{ total: number, docs: Doc[] }> => {
  if (!state) return { total: 0, docs: [] }
  const args = ['FT.SEARCH', index(), query === '*' ? state.live : `${state.live} ${query}`]
  if (opts.sortBy) args.push('SORTBY', opts.sortBy, 'ASC')
  args.push('LIMIT', String(opts.offset ?? 0), String(opts.limit ?? 200))
  const fields = opts.fields ?? FIELDS
  args.push('RETURN', String(fields.length), ...fields, 'DIALECT', '2')
  const reply = await cmd<unknown[]>(args)
  const docs: Doc[] = []
  for (let i = 1; i + 1 < reply.length; i += 2) {
    const kv = reply[i + 1] as string[]
    const d: Doc = { key: String(reply[i]) }
    for (let j = 0; j + 1 < kv.length; j += 2) d[kv[j]!] = kv[j + 1]!
    docs.push(d)
  }
  return { total: Number(reply[0]), docs }
}

// notations by name and part

// one notation per name
const notations = (entries: NameEntry[]): Notation[] => {
  const groups = new Map<string, { ids: Set<string>, fixities: Map<string, number>, syntax?: El[], keep?: [number[], number], fields?: Set<string>[] }>()
  for (const e of entries) {
    let g = groups.get(e.n)
    if (!g) groups.set(e.n, (g = { ids: new Set(), fixities: new Map() }))
    g.ids.add(e.i)
    g.syntax ??= e.s
    g.keep ??= e.k
    if (e.f) {
      g.fields ??= e.f.map(() => new Set())
      e.f.forEach((f, i) => g.fields![i]?.add(f))
    }
    const f = `${e.a} ${e.l}`
    g.fixities.set(f, (g.fixities.get(f) ?? 0) + 1)
  }
  return [...groups].map(([name, g]) => {
    const [assoc, level] = [...g.fixities].sort((a, b) => b[1] - a[1])[0]![0].split(' ')
    return { name, ids: g.ids, assoc: assoc as Notation['assoc'], level: Number(level), ...(g.syntax ? { syntax: g.syntax } : {}), ...(g.keep ? { keep: g.keep } : {}), ...(g.fields ? { fields: g.fields } : {}) }
  })
}

// entries by key
const lookupAll = async (kind: string, keys: string[], lib?: string): Promise<Map<string, unknown[]>> => {
  const out = new Map<string, unknown[]>()
  const unique = [...new Set(keys)]
  if (!state || unique.length === 0) return out
  const libs = state.libs.filter(l => !lib || l.name === lib)
  const replies = await Promise.all(libs.map(l => cmd<(string | null)[]>(['HMGET', libKey(kind, l.name, l.gen), ...unique])))
  for (const values of replies) {
    unique.forEach((k, i) => {
      if (values[i]) out.set(k, [...(out.get(k) ?? []), ...(JSON.parse(values[i]) as unknown[])])
    })
  }
  return out
}

export const resolveNames = async (names: string[], lib?: string): Promise<Map<string, Notation[]>> => {
  const found = await lookupAll('names', names, lib)
  return new Map([...found].map(([k, v]) => [k, notations(v as NameEntry[])]))
}

// per-generation cache
export const cached = <T>(key: string, make: () => T): T => {
  if (!state) return make()
  const caches = state.caches
  if (!caches.has(key)) {
    const v = make()
    caches.set(key, v)
    // failures aren't kept
    if (v instanceof Promise) v.catch(() => caches.get(key) === v && caches.delete(key))
  }
  return caches.get(key) as T
}

// folded names by id
export const namesById = (lib: string): Promise<Map<string, string>> => {
  const l = libraries().find(x => x.name === lib)
  if (!l) return Promise.resolve(new Map<string, string>())
  const key = libKey('names', lib, l.gen)
  return cached(`byId:${lib}`, async () => {
    const m = new Map<string, string>()
    const all = await cmd<string[]>(['HGETALL', key])
    for (let i = 1; i < all.length; i += 2) {
      for (const e of JSON.parse(all[i]!) as NameEntry[]) if (!m.has(e.i) || e.n.length < m.get(e.i)!.length) m.set(e.i, e.n)
    }
    return m
  })
}

export const notationsWithParts = async (parts: string[], lib: string): Promise<string[]> =>
  [...new Set([...(await lookupAll('parts', parts, lib)).values()].flat() as string[])]

const EMPTY: Scope = { parts: new Set(), concrete: new Set(), templates: [] }

export const scope = (lib: string): Scope => state?.scopes.get(lib) ?? EMPTY

export const rigidTypes = (): Set<string> => state?.rigid ?? new Set()

export const env = (names: Map<string, Notation[]>, lib: string): Env => ({ names, concrete: scope(lib).concrete, nat: state?.nat })

// loading

const FETCH_MS = 60_000
const BATCH = 500
const TYPE_KINDS = new Set(['data', 'record', 'prim', 'postulate'])
// injective constants
const RIGID_KINDS = new Set([...TYPE_KINDS, 'con'])
// type letters
const VARIABLE_LIKE = /^\p{L}[\d']*$/u
const NUMBERS = /^[ℕℤℚ]$/u
const FORMAT = 2

const SCHEMA = [
  'gen', 'TAG',
  'name', 'TAG',
  'key', 'TAG', 'SEPARATOR', '\x1f', 'CASESENSITIVE',
  'lib', 'TAG', 'kind', 'TAG', 'mods', 'TAG', 'consts', 'TAG', 'head', 'TAG', 'self', 'TAG',
  'size', 'NUMERIC', 'SORTABLE', 'namelen', 'NUMERIC', 'SORTABLE', 'refs', 'NUMERIC', 'SORTABLE', 'arity', 'NUMERIC'
]

const download = async (src: string): Promise<Buffer> => {
  if (!/^https?:/.test(src)) return readFile(src)
  const response = await fetch(src, { signal: AbortSignal.timeout(FETCH_MS) })
  if (!response.ok) throw new Error(`${src}: ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

const lines = (src: string, raw: Buffer) => {
  const input = Readable.from([raw])
  return createInterface({ input: src.endsWith('.gz') ? input.pipe(createGunzip()) : input, crlfDelay: Infinity })
}

interface Meta {
  library: string
  commit?: string
  url?: string
  source?: string
  agda?: string
  format?: number
  // indexer build
  build?: string
  builtins?: Record<string, string>
}

const LITERALS: Record<string, NameInfo['inline']> = { fromNat: 'lit', fromNeg: 'neg', fromString: 'lit', zero: 'zero', suc: 'suc' }

const firstLine = async (src: string, raw: Buffer): Promise<Meta> => {
  const rl = lines(src, raw)
  try {
    for await (const line of rl) {
      const meta = (JSON.parse(line) as { meta?: Partial<Meta> }).meta
      if (!meta || typeof meta.library !== 'string' || !/^[\w.-]+$/.test(meta.library)) break
      if (meta.format !== FORMAT) throw new Error(`${meta.library}: unsupported index format ${meta.format ?? 1}`)
      return meta as Meta
    }
  } catch (err) {
    if (err instanceof SyntaxError) throw new Error(`malformed index file ${src}`, { cause: err })
    throw err
  } finally {
    rl.close()
  }
  throw new Error(`malformed index file ${src}`)
}

interface RawName {
  q: string
  n: string
  fix?: [string, number]
  np?: number
  same?: string
  lvl?: boolean
  syntax?: [string, string | number, number?][]
  keep?: [number[], number]
  tpl?: unknown[]
  tplvis?: boolean[]
  fields?: number[]
}

interface RawEntry {
  name: string
  module: string
  file: string
  kind: string
  type: string
  term: unknown
  unf?: unknown
  qname?: number
  line?: number
  pos: number
  copy?: boolean
  alias?: string
}

const validEntry = (e: Record<string, unknown>): boolean =>
  typeof e.name === 'string' && typeof e.module === 'string' && typeof e.file === 'string' && typeof e.type === 'string' &&
  typeof e.kind === 'string' && typeof e.pos === 'number' && (e.alias == null || typeof e.alias === 'string') && e.term !== undefined

// _++_ also as ++
const bare = (name: string): string => name.replace(/_/g, '')

// name entry
interface NameEntry {
  n: string
  i: string
  a: string
  l: number
  s?: El[]
  k?: [number[], number]
  f?: string[]
}

// alias body as term
const templateOf = (raw: unknown[], info: (i: number) => NameInfo | undefined): Term | null => {
  const spine = (xs: unknown[]): Term[] | null => {
    const out: Term[] = []
    for (const x of xs) {
      const [h, a] = x as [number, unknown[]]
      if (h !== 0) continue
      const t = go(a)
      if (!t) return null
      out.push(t)
    }
    return out
  }
  const go = (t: unknown[]): Term | null => {
    switch (t[0]) {
      case 'P': {
        const a = spine(t.slice(2))
        return a && { k: 'm', m: `t:${String(t[1])}`, a }
      }
      case 'B': {
        const a = spine(t.slice(2))
        return a && { k: 'b', i: t[1] as number, a }
      }
      case 'C': {
        const n = info(t[1] as number)
        if (!n || n.lvl) return null
        if (n.sort) return { k: 's' }
        const a = spine(t.slice(2))
        return a && { k: 'c', id: n.id, a }
      }
      case 'L': {
        if (t[1] !== 0) return null
        const b = go(t[2] as unknown[])
        return b && { k: 'l', b }
      }
      case 'N': return { k: 'n', v: String(t[1]) }
      default: return null
    }
  }
  return go(raw)
}

// syntax parts, folded
const syntaxOf = (raw: RawName['syntax']): El[] | undefined =>
  raw?.map(([k, a, b]) => (k === 'i' ? { k: 'part' as const, part: ascii(String(a)) } : k === 'h' ? { k: 'hole' as const, n: Number(a), ...(b ? { hidden: true } : {}) } : { k: 'bind' as const, hole: Number(a), v: Number(b) }))

const unlinkMatching = async (pattern: string): Promise<void> => {
  let cursor = '0'
  do {
    const [next, keys] = await cmd<[string, string[]]>(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '2000'])
    cursor = next
    if (keys.length > 0) await cmd(['UNLINK', ...keys])
  } while (cursor !== '0')
}

const dropGeneration = async (lib: string, gen: string): Promise<void> => {
  await unlinkMatching(`${docPrefix(lib, gen)}*`)
  await cmd(['UNLINK', libKey('names', lib, gen), libKey('parts', lib, gen), libKey('concrete', lib, gen), libKey('builtins', lib, gen), libKey('templates', lib, gen), libKey('rigid', lib, gen)])
  await cmd(['SREM', gensKey(), genTag(lib, gen)])
}

const ensureIndex = async (): Promise<void> => {
  const { schema } = await readMeta()
  if (schema === SCHEMA_VERSION) {
    const exists = await cmd(['FT.INFO', index()]).then(() => true, () => false)
    if (exists) return
  }
  // old shape, start over
  await cmd(['FT.DROPINDEX', index(), 'DD']).catch(() => {})
  await unlinkMatching(`${prefix()}:*`)
  await cmd(['FT.CREATE', index(), 'ON', 'HASH', 'PREFIX', '1', `${prefix()}:d:`, 'STOPWORDS', '0', 'SCHEMA', ...SCHEMA])
  await cmd(['HSET', metaKey(), 'schema', SCHEMA_VERSION, 'order', '[]'])
  state = null
}

// load into fresh generation
const loadLibrary = async (src: string, raw: Buffer, meta: Meta, gen: string, builtins: Map<string, string>): Promise<Library> => {
  const lib: Library = { name: meta.library, commit: String(meta.commit ?? ''), url: String(meta.url ?? ''), source: String(meta.source ?? ''), agda: String(meta.agda ?? ''), build: String(meta.build ?? ''), count: 0, format: FORMAT, gen }
  const builtinOf = new Map(Object.entries(meta.builtins ?? {}).map(([k, q]) => [q, k]))
  if (meta.builtins?.zero) lib.zero = hash(meta.builtins.zero)
  if (meta.builtins?.suc) lib.suc = hash(meta.builtins.suc)
  const names = new Map<string, Map<string, NameEntry>>()
  const note = (k: string, entry: NameEntry) => {
    let m = names.get(k)
    if (!m) names.set(k, (m = new Map<string, NameEntry>()))
    m.set(`${entry.n} ${entry.i}`, entry)
  }
  const noteBoth = (folded: string, entry: NameEntry) => {
    note(folded, entry)
    if (bare(folded) && bare(folded) !== folded) note(bare(folded), entry)
  }
  const concrete = new Set<string>()
  // rigid type formers
  const rigid = new Set<string>()
  const syntaxParts = new Map<string, Set<string>>()
  const owned: string[] = []
  const refs = new Map<string, number>()
  const owners: [string, string][] = []
  const table: RawName[] = []
  const templates: Template[] = []
  let canonical = canonicaliser([])
  let infos: NameInfo[] | null = null
  const resolve = (): NameInfo[] => {
    const byQ = new Map(table.map(r => [r.q, r]))
    // Σ-syntax = Σ, Type ℓ = Set ℓ
    const canon = (r: RawName): { q: string, sort: boolean } => {
      let q = r.q
      for (let i = 0; i < 10; i++) {
        const t = byQ.get(q)
        if (!t?.same) break
        if (t.same === 'sort') return { q, sort: true }
        q = t.same
      }
      return { q, sort: isSortName(q) }
    }
    const infos = table.map(r => {
      const c = canon(r)
      const builtin = builtinOf.get(r.q)
      return { id: hash(c.q), sort: c.sort || undefined, np: r.np, lvl: r.lvl, inline: (builtin && LITERALS[builtin]) || inlineOf(r.n), keep: r.keep }
    })
    table.forEach((r, idx) => {
      const info = infos[idx]!
      const fix = r.fix ?? ['non', 20]
      const syntax = syntaxOf(r.syntax)
      const entry: NameEntry = { n: ascii(r.n), i: info.id, a: fix[0], l: fix[1] }
      if (syntax) entry.s = syntax
      if (r.keep) entry.k = r.keep
      if (r.fields?.every(f => infos[f])) entry.f = r.fields.map(f => infos[f]!.id)
      noteBoth(ascii(r.n), entry)
      // Σ[ … ] by parts
      if (syntax) for (const e of syntax) if (e.k === 'part') (syntaxParts.get(e.part) ?? syntaxParts.set(e.part, new Set()).get(e.part)!).add(ascii(r.n))
      const body = r.tpl && r.tplvis ? templateOf(r.tpl, i => infos[i]) : null
      if (body && r.tplvis) templates.push({ id: info.id, vis: r.tplvis, body, refs: uses[idx] ?? 0 })
    })
    canonical = canonicaliser(templates)
    return infos
  }
  let pending: Promise<unknown>[] = []
  const flush = async () => {
    await Promise.all(pending)
    pending = []
  }
  // name use counts
  const uses: number[] = []
  for await (const line of lines(src, raw)) {
    for (const m of line.matchAll(/\["c",(\d+)\]/g)) uses[Number(m[1])] = (uses[Number(m[1])] ?? 0) + 1
  }
  let n = 0
  let first = true
  for await (const line of lines(src, raw)) {
    if (first) {
      first = false
      continue
    }
    if (!line) continue
    const row = JSON.parse(line) as Record<string, unknown>
    if (typeof row.q === 'string') {
      table.push(row as unknown as RawName)
      continue
    }
    infos ??= resolve()
    if (!validEntry(row)) continue
    const e = row as unknown as RawEntry
    // shared builtins
    if (e.module.startsWith('Agda.')) {
      const k = `${e.module}.${e.name}`
      const owner = builtins.get(k)
      if (owner && owner !== lib.name) continue
      builtins.set(k, lib.name)
      owned.push(k)
    }
    let written, unfolded
    const typing: Typing = { types: [], argVars: [] }
    const utyping: Typing = { types: [], argVars: [] }
    try {
      written = normalise(e.term, i => infos![i], typing)
      unfolded = e.unf === undefined ? undefined : normalise(e.unf, i => infos![i], utyping)
    } catch {
      continue
    }
    // canonical types
    const sig = canonical(decode(written, 'c', typing))
    const usig = unfolded && canonical(decode(unfolded, 'c', utyping))
    written = encode(sig)
    unfolded = usig && encode(usig)
    const cs = new Set([...consts(sig), ...(usig ? consts(usig) : [])])
    const heads = new Set([headId(sig.res), usig && headId(usig.res)].filter((h): h is string => Boolean(h)))
    const folded = ascii(e.name)
    const own = typeof e.qname === 'number' ? infos[e.qname]?.id : undefined
    // renamed re-exports
    if (e.alias && own) noteBoth(folded, { n: folded, i: own, a: 'non', l: 20 })
    if (TYPE_KINDS.has(e.kind) && VARIABLE_LIKE.test(folded) && (NUMBERS.test(e.name) || /\d/.test(folded))) concrete.add(folded)
    for (const c of cs) refs.set(c, (refs.get(c) ?? 0) + 1)
    if (own && RIGID_KINDS.has(e.kind)) rigid.add(own)
    const doc = `${docPrefix(lib.name, gen)}${n++}`
    if (own) owners.push([doc, own])
    const fields: string[] = [
      'gen', genTag(lib.name, gen),
      'name', [hash(folded), hash(bare(folded) || folded)].join(','),
      'key', folded.toLowerCase(),
      'lib', lib.name,
      'kind', e.alias ? `${e.kind},alias` : e.kind,
      'mods', segmentRuns(e.module).map(hash).join(','),
      'consts', [...cs].join(','),
      'head', [...heads].join(','),
      'size', String(size(sig)),
      // most explicit arguments
      'arity', String(Math.max(sig.args.length, usig?.args.length ?? 0)),
      'namelen', String(e.name.length),
      'n', e.name, 'm', e.module, 'f', e.file, 'k', e.kind, 't', e.type,
      'j', JSON.stringify(written),
      'l', String(e.line ?? 0), 'p', String(e.pos)
    ]
    // typing data
    const np = typeof e.qname === 'number' ? infos[e.qname]?.np ?? 0 : 0
    fields.push('y', JSON.stringify({ ...encodeTyping(sig), np }))
    if (own) fields.push('self', own)
    if (unfolded && usig) fields.push('u', JSON.stringify(unfolded), 'uy', JSON.stringify(encodeTyping(usig)))
    if (e.copy) fields.push('c', '1')
    if (e.alias) fields.push('a', e.alias)
    pending.push(cmd(['HSET', doc, ...fields]))
    lib.count++
    if (pending.length >= BATCH) await flush()
  }
  infos ??= resolve()
  await flush()
  // use counts
  for (let i = 0; i < owners.length; i += BATCH) {
    await Promise.all(owners.slice(i, i + BATCH).map(([doc, id]) => cmd(['HSET', doc, 'refs', String(refs.get(id) ?? 0)])))
  }
  const entries = [...names].map(([k, m]) => [k, JSON.stringify([...m.values()])])
  for (let i = 0; i < entries.length; i += BATCH) await cmd(['HSET', libKey('names', lib.name, gen), ...entries.slice(i, i + BATCH).flat()])
  const parts = new Map<string, Set<string>>(syntaxParts)
  for (const m of names.values()) {
    for (const { n: name } of m.values()) {
      if (!name.includes('_') || name === '_') continue
      for (const p of name.split('_').filter(Boolean)) {
        let s = parts.get(p)
        if (!s) parts.set(p, (s = new Set()))
        s.add(name)
      }
    }
  }
  const partEntries = [...parts].map(([p, s]) => [p, JSON.stringify([...s])])
  for (let i = 0; i < partEntries.length; i += BATCH) await cmd(['HSET', libKey('parts', lib.name, gen), ...partEntries.slice(i, i + BATCH).flat()])
  if (concrete.size > 0) await cmd(['SADD', libKey('concrete', lib.name, gen), ...concrete])
  if (owned.length > 0) await cmd(['SADD', libKey('builtins', lib.name, gen), ...owned])
  await cmd(['SET', libKey('templates', lib.name, gen), JSON.stringify(templates)])
  for (const t of templates) rigid.add(t.id)
  if (rigid.size > 0) await cmd(['SADD', libKey('rigid', lib.name, gen), ...rigid])
  return lib
}

// redis bytes per index byte, gz and plain
const PER_GZ_BYTE = 30
const PER_BYTE = 5

const mb = (n: number): string => `${Math.round(n / 1048576)}MB`

// why it won't fit
export const roomFor = (used: number, max: number, need: number): string | null =>
  max > 0 && used + need > max * 0.95 ? `not enough redis memory, ${mb(used)} used of ${mb(max)} and it needs about ${mb(need)}` : null

// estimated room for a generation
const noRoom = async (src: string, raw: Buffer, current: Library | undefined): Promise<string | null> => {
  // config can be disabled
  const max = Number((await cmd<string[]>(['CONFIG', 'GET', 'maxmemory']).catch(() => []))[1] ?? 0)
  if (!max) return null
  const used = Number(/used_memory:(\d+)/.exec(await cmd<string>(['INFO', 'memory']))?.[1] ?? 0)
  const total = indexSize()
  const need = current && total > 0 ? (used * current.count) / total : raw.length * (src.endsWith('.gz') ? PER_GZ_BYTE : PER_BYTE)
  return roomFor(used, max, need)
}

export interface LoadResult {
  // reloaded libraries
  loaded: string[]
  count: number
  // failed sources
  skipped: string[]
}

// one load at a time
let queue: Promise<unknown> = Promise.resolve()

// url or path, .gz ok; force reloads all
export const loadIndex = (sources: string[], force = false): Promise<LoadResult> => {
  const next = queue.then(() => load(sources, force))
  queue = next.catch(() => {})
  return next
}

const load = async (sources: string[], force: boolean): Promise<LoadResult> => {
  await ensureIndex()
  await sweep()
  const read = await Promise.allSettled(sources.map(async src => {
    const raw = await download(src)
    return { src, raw, meta: await firstLine(src, raw) }
  }))
  const ok = read.flatMap(r => (r.status === 'fulfilled' ? [r.value] : []))
  const skipped = read.flatMap((r, i) => (r.status === 'rejected' ? [`${sources[i]}: ${(r.reason as Error).message}`] : []))
  if (ok.length === 0) throw (read[0] as PromiseRejectedResult | undefined)?.reason ?? new Error('no index sources')
  const { libs: live } = await readMeta()
  const byName = new Map(live.map(l => [l.name, l]))
  // builtin owners
  const builtins = new Map<string, string>()
  const loaded: string[] = []
  // failed downloads keep unnamed libraries
  const order = [...ok.map(o => o.meta.library), ...(skipped.length > 0 ? live.map(l => l.name).filter(n => !ok.some(o => o.meta.library === n)) : [])]
  // per library: load, publish, drop old
  const publish = async (l: Library) => {
    await cmd(['HSET', metaKey(), 'order', JSON.stringify(order), `lib:${l.name}`, JSON.stringify(l)])
    await refreshNow()
  }
  for (const { src, raw, meta } of ok) {
    const current = byName.get(meta.library)
    // unchanged
    const same = current && current.commit === String(meta.commit ?? '') && current.format === FORMAT && current.agda === String(meta.agda ?? '') && (current.build ?? '') === String(meta.build ?? '')
    if (current && !force && same) {
      // skip owned builtins
      for (const k of await cmd<string[]>(['SMEMBERS', libKey('builtins', current.name, current.gen)])) if (!builtins.has(k)) builtins.set(k, current.name)
      continue
    }
    // must fit under maxmemory
    const full = await noRoom(src, raw, current)
    if (full) {
      skipped.push(`${src}: ${full}`)
      continue
    }
    const gen = String(await cmd<number>(['INCR', `${prefix()}:gen`]))
    // registered first
    await cmd(['SADD', gensKey(), genTag(meta.library, gen)])
    let lib: Library
    try {
      lib = await loadLibrary(src, raw, meta, gen, builtins)
    } catch (err) {
      await dropGeneration(meta.library, gen)
      skipped.push(`${src}: ${(err as Error).message}`)
      continue
    }
    await publish(lib)
    loaded.push(meta.library)
    if (current) await dropGeneration(current.name, current.gen)
  }
  // dropped libraries
  const gone = live.filter(l => !order.includes(l.name))
  if (gone.length > 0 || live.length !== order.length) {
    await cmd(['HSET', metaKey(), 'order', JSON.stringify(order.filter(n => byName.has(n) || loaded.includes(n)))])
    for (const l of gone) await cmd(['HDEL', metaKey(), `lib:${l.name}`])
    await refreshNow()
    for (const l of gone) await dropGeneration(l.name, l.gen)
  }
  await refreshNow()
  return { loaded, count: indexSize(), skipped }
}

// orphan generations
const sweep = async (): Promise<void> => {
  const { libs, schema } = await readMeta()
  if (schema !== SCHEMA_VERSION) return
  const live = new Set(libs.map(l => genTag(l.name, l.gen)))
  const dead = new Set((await cmd<string[]>(['SMEMBERS', gensKey()])).filter(t => !live.has(t)))
  const names = `${prefix()}:names:`
  let cursor = '0'
  do {
    const [next, keys] = await cmd<[string, string[]]>(['SCAN', cursor, 'MATCH', `${names}*`, 'COUNT', '1000'])
    cursor = next
    for (const k of keys) {
      const t = k.slice(names.length)
      if (!live.has(t)) dead.add(t)
    }
  } while (cursor !== '0')
  for (const d of dead) {
    const at = d.lastIndexOf(':')
    await dropGeneration(d.slice(0, at), d.slice(at + 1))
  }
}

// all keys, for tests
export const wipe = async (): Promise<void> => {
  await cmd(['FT.DROPINDEX', index(), 'DD']).catch(() => {})
  await unlinkMatching(`${prefix()}:*`)
  state = null
}

// live generations, for tests
export const generations = (): Record<string, string> => Object.fromEntries(libraries().map(l => [l.name, l.gen]))
