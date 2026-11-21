import { ascii, hash, plainModule, segments } from './fold.ts'
import { chunks, lex, parse, toQuery, type Env, type Q as Parsed, type Query } from './parse.ts'
import { cached, env, libraries, notationsWithParts, resolveNames, rigidTypes, scope, search, tag, tags, type Doc, type Library } from './store.ts'
import { apply, consts, decode, instantiate, larger, subterms, termKey, TooBig, type Sig, type Term, type Typing } from './term.ts'
import { canonicaliser, unfolder } from './canon.ts'
import { wellTyped, type Context, type Signature } from './typing.ts'
import { merged, resolve as resolveMeta, specialised, unify, type Budget, type Subst } from './unify.ts'

export type { Library } from './store.ts'

// bot's view of a definition
export interface AgdaEntry {
  name: string
  module: string
  file: string
  kind: string
  type: string
  line: number
  pos: number
  copy?: boolean
  alias?: string
}

export interface Hit {
  entry: AgdaEntry
  lib: Library
  // fallback rewrite
  via?: string
  match?: Match
}

const LIMIT = 200
export const MAX_QUERY = 300

const hit = (d: Doc, via?: string): Hit => {
  const lib = libraries().find(l => l.name === d.lib) ?? { name: d.lib ?? '', commit: '', url: '', source: '', agda: '', count: 0, format: 0, gen: '' }
  const entry: AgdaEntry = { name: d.n ?? '', module: d.m ?? '', file: d.f ?? '', kind: d.k ?? '', type: d.t ?? '', line: Number(d.l ?? 0), pos: Number(d.p ?? 0) }
  if (d.c) entry.copy = true
  if (d.a) entry.alias = d.a
  return via ? { entry, lib, via } : { entry, lib }
}

// copies last
const tiebreak = (d: Doc): number => (d.n ?? '').length + (d.m ?? '').length / 100 + (d.c ? 50 : 0)

// filters

const KINDS: Record<string, string> = {
  fun: 'fun', function: 'fun', def: 'fun', data: 'data', record: 'record', con: 'con', constructor: 'con',
  field: 'field', prim: 'prim', primitive: 'prim', postulate: 'postulate', axiom: 'postulate', alias: 'alias'
}

const FILTER = /^(-?)(lib|kind|in):(\S+)$/i

// filter clauses
export const splitFilters = (q: string): { query: string, filter: string, error?: string } => {
  const clauses: string[] = []
  const words: string[] = []
  for (const w of q.split(' ').filter(Boolean)) {
    const m = FILTER.exec(w)
    if (!m) {
      words.push(w)
      continue
    }
    const not = m[1] ? '-' : ''
    const values = m[3]!.split(',').filter(Boolean)
    switch (m[2]!.toLowerCase()) {
      case 'lib': {
        const known = libraries().map(l => l.name)
        const libs = values.flatMap(v => known.filter(l => l.toLowerCase().startsWith(v.toLowerCase())))
        if (libs.length === 0) return { query: q, filter: '', error: `Unknown library \`${m[3]}\`, try ${known.join(', ') || 'none loaded'}.` }
        clauses.push(`${not}${tags('lib', libs)}`)
        break
      }
      case 'kind': {
        const kinds = values.map(v => KINDS[v.toLowerCase()])
        if (kinds.some(k => !k)) return { query: q, filter: '', error: `Unknown kind \`${m[3]}\`, try ${[...new Set(Object.values(KINDS))].join(', ')}.` }
        clauses.push(`${not}${tags('kind', kinds as string[])}`)
        break
      }
      case 'in':
        // module segments
        clauses.push(`${not}${tags('mods', values.map(v => hash(ascii(v).toLowerCase().replace(/^\.+|\.+$/g, ''))))}`)
        break
    }
  }
  return { query: words.join(' '), filter: clauses.join(' ') }
}

const withFilter = (query: string, filter: string): string => (filter ? (query === '*' ? filter : `${query} ${filter}`) : query)

// names

const nameMatches = async (name: string, quals: string[], filter: string): Promise<Doc[]> => {
  const folded = ascii(name)
  const qual = ascii(quals.join('.'))
  const { docs } = await search(withFilter(tags('name', [hash(folded)]), filter), { limit: 1000, sortBy: 'namelen' })
  let found = docs.filter(d => {
    const m = ascii(plainModule(d.m ?? ''))
    return !qual || m === qual || `${m}.`.endsWith(`.${qual}.`)
  })
  // full module name
  if (qual && found.some(d => ascii(plainModule(d.m ?? '')) === qual)) found = found.filter(d => ascii(plainModule(d.m ?? '')) === qual)
  // prefer the name as typed
  const typed = (d: Doc) => d.n === name || d.n?.replace(/_/g, '') === name
  if (found.some(typed)) found = found.filter(typed)
  return found.sort((a, b) => tiebreak(a) - tiebreak(b))
}

const lookupDocs = async (q: string, filter = ''): Promise<Doc[]> => {
  const segs = q.split('.')
  for (let k = segs.length - 1; k >= 0; k--) {
    const quals = segs.slice(0, k)
    const name = segs.slice(k).join('.')
    if (!name || !quals.every(s => /^\p{L}/u.test(s))) continue
    const found = await nameMatches(name, quals, filter)
    if (found.length > 0) return found
  }
  return []
}

// exact or qualified name
export const lookupName = async (q: string, filter = ''): Promise<Hit[]> => (await lookupDocs(q, filter)).map(d => hit(d))

const WORD = /[\p{L}\p{N}]/u
const UPPER = /\p{Lu}/u

// word starts
const atWord = (t: string, folded: string, key: string): boolean => {
  for (let i = key.indexOf(t, 1); i > 0; i = key.indexOf(t, i + 1)) {
    const prev = folded[i - 1]!
    if (!WORD.test(prev) || (UPPER.test(folded[i]!) && !UPPER.test(prev))) return true
  }
  return false
}

// name match ranks
const tier = (t: string, d: Doc): number => {
  const folded = ascii(d.n ?? '')
  const key = folded.toLowerCase()
  return key === t ? 0
    : key.startsWith(t) ? 1
    : atWord(t, folded, key) ? 2
    : key.includes(t) ? 3
    : segments(d.m ?? '').includes(t) ? 4
    : edits(t, key) <= 2 ? 5
    : 6
}

const CANDIDATES = 2000

// bounded levenshtein
const edits = (a: string, b: string): number => {
  if (Math.abs(a.length - b.length) > 2) return 3
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const row = [i]
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = row
  }
  return prev[b.length]!
}

// filters alone
export const searchNames = async (q: string, filter = ''): Promise<Hit[]> => {
  const terms = ascii(q).toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) {
    if (!filter) return []
    const { docs } = await search(filter, { limit: LIMIT, sortBy: 'namelen' })
    return docs.sort((a, b) => tiebreak(a) - tiebreak(b)).map(d => hit(d))
  }
  const near = terms.map(t => `(@key:{*${tag(t)}*} | ${tags('mods', [hash(t)])})`).join(' ')
  let { docs } = await search(withFilter(near, filter), { limit: CANDIDATES, sortBy: 'namelen' })
  // subsequences last
  if (docs.length === 0) {
    const loose = terms.map(t => `@key:{w'*${[...t].map(ch => (/[\p{L}\p{N}]/u.test(ch) ? ch : `\\${ch}`)).join('*')}*'}`).join(' ')
    ;({ docs } = await search(withFilter(loose, filter), { limit: CANDIDATES, sortBy: 'namelen' }))
  }
  // typos within two edits
  if (docs.every(d => terms.some(t => !ascii(d.n ?? '').toLowerCase().includes(t))) && terms.every(t => t.length >= 4)) {
    const half = terms.map(t => `@key:{*${tag(t.slice(0, Math.ceil(t.length / 2)))}*}`).join(' ')
    const near = (await search(withFilter(half, filter), { limit: CANDIDATES, sortBy: 'namelen' })).docs
    const seen = new Set(docs.map(d => d.key))
    docs = [...docs, ...near.filter(d => !seen.has(d.key) && terms.every(t => edits(t, ascii(d.n ?? '').toLowerCase()) <= 2))]
  }
  return docs
    .map(d => [terms.reduce((n, t) => n + tier(t, d), 0) * 100 + tiebreak(d), d] as [number, Doc])
    .sort((a, b) => a[0] - b[0])
    .slice(0, LIMIT)
    .map(([, d]) => hit(d))
}

// per-library resolution

const resolve = async (q: string, lib: string): Promise<{ toks: string[], env: Env }> => {
  const cs = chunks(q)
  const known = await resolveNames(cs, lib)
  const { parts } = scope(lib)
  const toks = lex(cs, w => known.has(w), parts)
  const ops = await notationsWithParts(toks.filter(t => parts.has(t)), lib)
  // x .fst names fst
  const words = toks.map(t => (/^\.\p{L}/u.test(t) ? t.slice(1) : t))
  const more = await resolveNames([...words, ...ops, '_*_'].filter(t => !known.has(t)), lib)
  const names = new Map([...known, ...more])
  // qualified names
  for (const t of words.filter(t => QUALIFIED.test(t) && !names.has(t))) {
    const hits = (await lookupDocs(t, tags('lib', [lib]))).map(d => hash(d.a ?? `${d.m}.${d.n}`))
    if (hits.length > 0) names.set(t, [{ name: t, ids: new Set(hits), assoc: 'non', level: 20 }])
  }
  const elsewhere = new Set((await resolveNames(words.filter(t => !names.has(t)))).keys())
  return { toks, env: { ...env(names, lib), elsewhere } }
}

const QUALIFIED = /^\p{Lu}[^.\s]*(\.[^.\s]+)+$/u

// canonical query
// per generation
const canonicalisers = new WeakMap<object, ReturnType<typeof canonicaliser>>()

const canonical = (q: Query, lib: string): Query => {
  const { templates } = scope(lib)
  if (templates.length === 0) return q
  let canon = canonicalisers.get(templates)
  if (!canon) canonicalisers.set(templates, (canon = canonicaliser(templates)))
  const sig = canon(q.sig)
  const declared = q.declared && new Map([...q.declared].map(([m, t]) => [m, canon({ args: [], res: t }).res]))
  const terms = [sig.res, ...sig.args]
  const found: Set<string>[] = []
  const visit = (t: Term) => {
    if (t.k === 'c') {
      if (typeof t.id !== 'string') found.push(t.id)
      else if (!t.id.startsWith('#')) found.push(new Set([t.id]))
    }
    if (t.k === 'c' || t.k === 'm' || t.k === 'b') t.a.forEach(visit)
    if (t.k === 'p') [t.d, t.c].forEach(visit)
    if (t.k === 'l') visit(t.b)
  }
  terms.forEach(visit)
  return { ...q, sig, consts: found, ...(declared ? { declared } : {}) }
}

// allowed libraries
const scoped = (filter: string): string[] => {
  const unescape = (v: string) => v.replace(/\\(.)/g, '$1')
  const only = /(?:^|\s)@lib:\{([^}]*)\}/.exec(filter)?.[1]?.split('|').map(unescape)
  const not = [...filter.matchAll(/-@lib:\{([^}]*)\}/g)].flatMap(m => m[1]!.split('|').map(unescape))
  return libraries().map(l => l.name).filter(n => (!only || only.includes(n)) && !not.includes(n))
}

// share remaining time
const slices = async (libs: string[], f: (lib: string, deadline: number) => Promise<void>): Promise<void> => {
  const end = performance.now() + SEARCH_MS
  for (let i = 0; i < libs.length; i++) await f(libs[i]!, performance.now() + (end - performance.now()) / (libs.length - i))
}

// mention filters
export const searchAbout = async (q: string, filter = ''): Promise<Hit[]> => {
  const ids = q.split(/\s+/).filter(Boolean)
  const include = ids.filter(id => !id.startsWith('-'))
  const exclude = ids.filter(id => id.startsWith('-') && id.length > 1).map(id => id.slice(1))
  if (include.length === 0) return []
  const names = await resolveNames([...include, ...exclude].map(ascii))
  const set = (w: string) => new Set((names.get(ascii(w)) ?? []).flatMap(n => [...n.ids]))
  const wanted = include.map(set)
  if (wanted.some(s => s.size === 0)) return []
  const clause = [...wanted.map(s => tags('consts', s)), ...exclude.map(set).filter(s => s.size > 0).map(s => `-${tags('consts', s)}`)].join(' ')
  const { docs } = await search(withFilter(clause, filter), { limit: CANDIDATES, sortBy: 'size' })
  // written types first
  const written = (d: Doc) => wanted.every(s => [...s].some(id => (d.j ?? '').includes(id)))
  return docs
    .map(d => [(written(d) ? 0 : 1000) + (d.t ?? '').length + (d.n ?? '').length, d] as [number, Doc])
    .sort((a, b) => a[0] - b[0])
    .slice(0, LIMIT)
    .map(([, d]) => hit(d))
}

// matching

const MAX_STEPS = 4000
const SEARCH_MS = Number(process.env.AGDA_SEARCH_MS) || 300
const MAX_ARGS = 8
const SCAN = 500
const FALLBACK_BELOW = 5
const REWRITE = 500
// specialisation limit
const GOOD = 2000

export type Mode = 'sig' | 'conclusion' | 'anywhere'

const copy = (s: Subst): Subst => new Map(s)

// specialised variables
// typing's query specialisations count
const cost = (s: Subst, typed: Subst = s): number | null => {
  if (merged(typed) || collapsed(typed)) return null
  const k = specialised(typed, m => m.startsWith('q:'), 2) + specialised(s, m => m.startsWith('c'), 2)
  // swallowing limit
  return k > MAX_SPECIALISED ? null : k
}

const MAX_SPECIALISED = 4
// typings per candidate
const MAX_CHECKS = 8

// same-term variables merged
const collapsed = (s: Subst): boolean => {
  const seen = new Set<string>()
  for (const m of s.keys()) {
    if (!m.startsWith('q:')) continue
    const t = zonk({ k: 'm', m, a: [] }, s)
    // variables are merged()'s
    if (t.k === 'm' && t.a.length === 0) continue
    const key = termKey(t)
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

// unused premise, unfolded statement
const PREMISE = 1
const UNFOLDED = 2

// typing context
export interface QueryTypes {
  declared: Map<string, Term>
  // unloaded signatures
  missing?: Set<string>
  // query argument binders
  binders?: (string | null)[]
  rigid: Set<string>
  unfold?: (t: Term & { k: 'c' }) => Term | null
}

const TYPE_STEPS = 2000

// signatures by id
const signatures = () => cached('sigs', () => new Map<string, Signature | null>())
const MAX_SIGS = 50_000
const SIG_CHUNK = 100

export const loadSignatures = async (want: Iterable<string>): Promise<void> => {
  const sigs = signatures()
  if (sigs.size > MAX_SIGS) sigs.clear()
  const missing = [...new Set(want)].filter(id => id && !id.startsWith('#') && !sigs.has(id))
  for (let i = 0; i < missing.length; i += SIG_CHUNK) {
    const chunk = missing.slice(i, i + SIG_CHUNK)
    const limit = chunk.length * 8
    const { docs } = await search(tags('self', chunk), { limit, fields: ['self', 'j', 'y'] })
    for (const d of docs) {
      if (!d.self || sigs.get(d.self)) continue
      try {
        const y = JSON.parse(d.y ?? '{}') as Partial<Typing> & { np?: number }
        sigs.set(d.self, { stored: JSON.parse(d.j ?? '[]') as unknown[], typing: { types: y.types ?? [], argVars: y.argVars ?? [] }, np: y.np ?? 0 })
      } catch {
        // malformed, no signature
      }
    }
    // full page, maybe truncated
    if (docs.length < limit) for (const id of chunk) if (!sigs.has(id)) sigs.set(id, null)
  }
}

// query telescope order
const queryOrdered = (s: Subst, q: Sig, binders: (string | null)[]): boolean => {
  const mentions = (t: Term, m: string): boolean => {
    switch (t.k) {
      case 'm': return t.m === m || t.a.some(x => mentions(x, m))
      case 'c': case 'b': return t.a.some(x => mentions(x, m))
      case 'p': return mentions(t.d, m) || mentions(t.c, m)
      case 'l': return mentions(t.b, m)
      default: return false
    }
  }
  return binders.every((b, i) => {
    const r = b ? resolveMeta(b, s) : null
    if (!r || r.k !== 'm' || r.a.length > 0) return true
    return q.args.slice(0, i).every(a => !mentions(zonk(a, s), r.m))
  })
}

// typed match or null
export const typedMatch = (s: Subst, q: Sig, c: Sig, qt?: QueryTypes): Subst | null => {
  if (!qt) return s
  if (qt.binders && !queryOrdered(s, q, qt.binders)) return null
  const sigs = signatures()
  const ctx: Context = { sigs: id => (sigs.has(id) ? sigs.get(id) : (qt.missing?.add(id), undefined)), types: c.types ?? [], rigid: id => qt.rigid.has(id), prefer: consts(c), declared: qt.declared, ...(qt.unfold ? { unfold: qt.unfold } : {}) }
  return wellTyped(ctx, s, [q.res, ...q.args], TYPE_STEPS)
}

// substitute known variables
export const zonk = (t: Term, s: Subst, depth = 0): Term => {
  if (depth > 20) return t
  switch (t.k) {
    case 'm': {
      const v = resolveMeta(t.m, s)
      const a = t.a.map(x => zonk(x, s, depth + 1))
      if (!v || (v.k === 'm' && v.m === t.m)) return { ...t, a }
      return zonk(a.length === 0 ? v : (apply(v, a) ?? { k: 'w' }), s, depth + 1)
    }
    case 'c': case 'b': return { ...t, a: t.a.map(x => zonk(x, s, depth + 1)) }
    case 'p': return { k: 'p', d: zonk(t.d, s, depth + 1), c: zonk(t.c, s, depth + 1) }
    case 'l': return { k: 'l', b: zonk(t.b, s, depth + 1) }
    default: return t
  }
}

// binder scoping
export const ordered = (s: Subst, levels: Map<string, number> = new Map()): boolean => {
  const levelOf = (m: string): number | undefined => {
    const j = /^c(\d+)$/.exec(m)
    return j ? Number(j[1]) : levels.get(m)
  }
  const later = (t: Term, k: number): boolean => {
    switch (t.k) {
      case 'm': {
        const j = levelOf(t.m)
        return (j !== undefined && j >= k) || t.a.some(x => later(x, k))
      }
      case 'c': case 'b': return t.a.some(x => later(x, k))
      case 'p': return later(t.d, k) || later(t.c, k)
      case 'l': return later(t.b, k)
      default: return false
    }
  }
  for (const m of s.keys()) {
    const j = /^c(\d+)$/.exec(m)
    if (!j) continue
    const t = zonk({ k: 'm', m, a: [] }, s)
    // merged either way
    if (t.k === 'm' && t.a.length === 0) continue
    if (later(t, Number(j[1]))) return false
  }
  return true
}

// query binders stay bound
const binderLevels = (s: Subst, c: Sig, used: number[], binders?: (string | null)[]): Map<string, number> | null => {
  const out = new Map<string, number>()
  const vars = c.argVars ?? []
  for (const [i, b] of (binders ?? []).entries()) {
    const k = used[i]
    if (!b || k === undefined) continue
    const r = resolveMeta(b, s)
    if (!r || r.k !== 'm' || r.a.length > 0) return null
    const own = vars[k]
    // argument's own variable
    if (own != null) {
      const o = resolveMeta(`c${own}`, s)
      if (!o || o.k !== 'm' || o.a.length > 0 || (o.m !== `c${own}` && o.m !== r.m)) return null
    }
    if (/^c\d+$/.test(r.m)) {
      if (own == null || r.m !== `c${own}`) return null
      continue
    }
    out.set(r.m, own ?? vars.slice(k + 1).find((v): v is number => v != null) ?? c.types?.length ?? Infinity)
  }
  return out
}

// match, lower better
interface Found {
  score: number
  subst: Subst
  // argument mapping
  args: number[]
  // matched subterm, binders rigid
  at?: Term
}

// match for agda checking
export interface Match {
  mode: Mode
  query: Sig
  cand: Sig
  subst: Subst
  args: number[]
  // unfolded type
  unfolded: boolean
  // matched subterm
  at?: Term
  // original query
  asked?: Sig
  // query argument binders
  binders?: (string | null)[]
}

const matchSig = (q: Sig, c: Sig, qt?: QueryTypes): Found | null => {
  if (q.args.length > c.args.length) return null
  const budget: Budget = { steps: MAX_STEPS }
  // bare variable results
  if (c.res.k === 'm' && c.res.a.length === 0 && q.res.k !== 'm') return null
  const s0: Subst = new Map()
  if (!unify(q.res, c.res, s0, budget)) return null
  const offset = c.args.length - q.args.length
  let best: Found | null = null
  const used: number[] = []
  // typing budget
  let checks = MAX_CHECKS
  // arguments in any order
  const go = (i: number, s: Subst, moved: number) => {
    if (budget.steps < 0) return
    if (i === q.args.length) {
      const k = cost(s)
      const levels = k === null ? null : binderLevels(s, c, used, qt?.binders)
      if (k === null || !levels || !ordered(s, levels)) return
      const score = offset * 2 + moved + k
      if (best !== null && score >= best.score) return
      if (--checks < 0) return
      const t = typedMatch(s, q, c, qt)
      const kt = t && cost(s, t)
      if (t && kt !== null && (best === null || offset * 2 + moved + kt < best.score) && !circular(t, c, used)) best = { score: offset * 2 + moved + kt, subst: t, args: [...used] }
      return
    }
    for (let k = 0; k < c.args.length; k++) {
      if (used.includes(k)) continue
      const s1 = copy(s)
      if (!unify(q.args[i]!, c.args[k]!, s1, budget)) continue
      used.push(k)
      go(i + 1, s1, moved + (k === i + offset ? 0 : 1))
      used.pop()
    }
  }
  go(0, s0, 0)
  return best
}

const matchConclusion = (q: Sig, c: Sig, qt?: QueryTypes): Found | null => {
  if (c.res.k === 'm' && c.res.a.length === 0) return null
  const s: Subst = new Map()
  if (!unify(q.res, c.res, s, { steps: MAX_STEPS })) return null
  const k = cost(s)
  const t = k === null || !ordered(s) ? null : typedMatch(s, q, c, qt)
  const kt = t && cost(s, t)
  return !t || kt === null || circular(t, c, []) ? null : { score: kt + PREMISE * (c.premises ?? 0), subst: t, args: [] }
}

// equal up to ambiguity
const same = (a: Term, b: Term): boolean => {
  switch (a.k) {
    case 'c': return b.k === 'c' && (typeof a.id === 'string' ? (typeof b.id === 'string' ? a.id === b.id : b.id.has(a.id)) : [...a.id].some(x => (typeof b.id === 'string' ? b.id === x : b.id.has(x)))) && a.a.length === b.a.length && a.a.every((x, i) => same(x, b.a[i]!))
    case 'm': return b.k === 'm' && a.m === b.m && a.a.length === b.a.length && a.a.every((x, i) => same(x, b.a[i]!))
    case 'b': return b.k === 'b' && a.i === b.i && a.a.length === b.a.length && a.a.every((x, i) => same(x, b.a[i]!))
    case 'p': return b.k === 'p' && same(a.d, b.d) && same(a.c, b.c)
    case 'l': return b.k === 'l' && same(a.b, b.b)
    case 'n': return b.k === 'n' && a.v === b.v
    case 's': return b.k === 's'
    case 'w': return b.k === 'w'
  }
}

// vacuous conclusions
const circular = (s: Subst, c: Sig, used: number[]): boolean => {
  const res = zonk(c.res, s)
  return c.args.some((a, k) => !used.includes(k) && same(zonk(a, s), res))
}

// candidate binders rigid
const rigid = (t: Term): Term => {
  switch (t.k) {
    case 'm': return { k: 'c', id: `#${t.m}`, a: t.a.map(rigid) }
    case 'c': case 'b': return { ...t, a: t.a.map(rigid) }
    case 'p': return { k: 'p', d: rigid(t.d), c: rigid(t.c) }
    case 'l': return { k: 'l', b: rigid(t.b) }
    default: return t
  }
}

const matchAnywhere = (q: Sig, c: Sig): Found | null => {
  const budget: Budget = { steps: MAX_STEPS }
  let best: Found | null = null
  for (const t of subterms({ args: c.args.map(rigid), res: rigid(c.res) })) {
    const s: Subst = new Map()
    if (unify(q.res, t, s, budget)) {
      const score = cost(s)
      if (score !== null && (best === null || score < best.score)) best = { score, subst: s, args: [], at: t }
    }
  }
  return best
}

const MATCH: Record<Mode, (q: Sig, c: Sig, qt?: QueryTypes) => Found | null> = { sig: matchSig, conclusion: matchConclusion, anywhere: matchAnywhere }
const CLASS: Record<Mode, number> = { sig: 0, conclusion: 0, anywhere: 3 }

interface Scored {
  score: number
  doc: Doc
  via?: string
  match?: Match
}

const typingOf = (raw: string | undefined): Typing | undefined => {
  if (!raw) return undefined
  const t = JSON.parse(raw) as Typing
  return Array.isArray(t.types) && Array.isArray(t.argVars) ? t : undefined
}

const docSigs = (d: Doc): Sig[] => {
  const out: Sig[] = []
  try {
    out.push(decode(JSON.parse(d.j ?? '[]') as unknown[], 'c', typingOf(d.y)))
    if (d.u) out.push(decode(JSON.parse(d.u) as unknown[], 'c', typingOf(d.uy)))
  } catch {
    // malformed, no signature
  }
  return out
}

// best doc score
const scoreDoc = (q: Sig, d: Doc, mode: Mode, qt?: QueryTypes): { score: number, match: Match } | null => {
  let best: { score: number, match: Match } | null = null
  for (const [unfolded, c] of docSigs(d).entries()) {
    let f: Found | null
    try {
      f = MATCH[mode](q, c, qt)
    } catch (err) {
      // over budget
      if (err instanceof TooBig) continue
      throw err
    }
    if (!f) continue
    const score = f.score + UNFOLDED * unfolded
    if (best === null || score < best.score) best = { score, match: { mode, query: q, cand: c, subst: f.subst, args: f.args, unfolded: unfolded > 0, ...(f.at ? { at: f.at } : {}) } }
  }
  if (!best) return null
  const { score, match } = best
  return { score: (score + CLASS[mode]) * 1000 + Number(d.size ?? 0) + (d.c ? 500 : 0) - Math.min(Number(d.refs ?? 0), 100) / 1000, match }
}

const constClause = (q: Query): string => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const ids of q.consts) {
    const k = [...ids].sort().join('|')
    if (seen.has(k)) continue
    seen.add(k)
    out.push(tags('consts', ids))
  }
  return out.join(' ')
}

const headClause = (t: Term): string => (t.k === 'c' && typeof t.id !== 'string' ? tags('head', t.id) : '')

// candidates by size until deadline, retried with signatures
const scan = async (query: string, filter: string, deadline: number, f: (d: Doc, retry: boolean) => boolean | void): Promise<void> => {
  for (let offset = 0; performance.now() < deadline; offset += SCAN) {
    const { docs } = await search(withFilter(query || '*', filter), { offset, limit: SCAN, sortBy: 'size' })
    const again: Doc[] = []
    for (const d of docs) {
      if (f(d, false)) again.push(d)
      if (performance.now() > deadline) break
    }
    if (again.length > 0) {
      await loadSignatures(again.flatMap(d => (d.consts ?? '').split(',')))
      for (const d of again) f(d, true)
    }
    if (docs.length < SCAN || performance.now() > deadline) return
  }
}

// unfolded aliases
const unfolders = new WeakMap<object, ReturnType<typeof unfolder>>()
const unfolderOf = (filter: string): ReturnType<typeof unfolder> | undefined => {
  const libs = scoped(filter)
  if (libs.length !== 1) return undefined
  const { templates } = scope(libs[0]!)
  let u = unfolders.get(templates)
  if (!u) unfolders.set(templates, (u = unfolder(templates)))
  return u
}

const run = async (qs: { q: Query, via?: string, asked?: Sig }[], mode: Mode, filter: string, deadline: number, into: Map<string, Scored>, skip?: Set<string>) => {
  for (const { q, via, asked } of qs) {
    const head = mode === 'anywhere' ? '' : headClause(q.sig.res)
    // arity check
    const arity = mode === 'sig' && q.sig.args.length > 0 ? `@arity:[${q.sig.args.length} +inf]` : ''
    if (mode !== 'anywhere') await loadSignatures(q.consts.flatMap(ids => [...ids]))
    const missing = new Set<string>()
    const qt = mode === 'anywhere' ? undefined : { declared: q.declared ?? new Map<string, Term>(), rigid: rigidTypes(), unfold: unfolderOf(filter), missing, ...(q.binders && via !== 'currying' ? { binders: q.binders } : {}) }
    await scan([constClause(q), head, arity].filter(Boolean).join(' '), filter, deadline, (d, retry) => {
      if (skip?.has(d.key!)) return
      missing.clear()
      const found = scoreDoc(q.sig, d, mode, qt)
      if (!found) return
      // retry with signatures
      if (!retry && missing.size > 0) return true
      const { score } = found
      const match = { ...found.match, ...(q.binders && via !== 'currying' ? { binders: q.binders } : {}), ...(asked ? { asked } : {}) }
      const prev = into.get(d.key!)
      if (!prev || score < prev.score) into.set(d.key!, via ? { score, doc: d, via, match } : { score, doc: d, match })
    })
  }
}

// up to isomorphism

const SYMMETRIC = new Set(['_=_', '_/=_', '_~=_', '_=~_', '_~~_', '_~_', '_<->_', '_<=>_', '_≗_', '_≋_', '_↭_', 'Iso'])
const COMMUTATIVE = new Set(['_*_', '_|+|_', '_/\\_', '_\\/_'])

interface Variant {
  sig: Sig
  via: string
}

const variants = (sig: Sig, names: Map<Set<string>, string>, times: Set<string> | undefined): Variant[] => {
  const out: Variant[] = []
  const name = (t: Term) => (t.k === 'c' && typeof t.id !== 'string' ? names.get(t.id) : undefined)
  const swap = (t: Term, ops: Set<string>): Term | null => {
    const n = name(t)
    if (t.k !== 'c' || !n || !ops.has(n) || t.a.length < 2) return null
    const a = [...t.a]
    ;[a[a.length - 2], a[a.length - 1]] = [a[a.length - 1]!, a[a.length - 2]!]
    return { ...t, a }
  }
  const at = (i: number, t: Term): Sig => (i < 0 ? { ...sig, res: t } : { ...sig, args: sig.args.map((a, k) => (k === i ? t : a)) })
  const positions: [number, Term][] = [[-1, sig.res], ...sig.args.map((a, i) => [i, a] as [number, Term])]
  for (const [i, t] of positions) {
    // symmetric relations
    const sym = swap(t, SYMMETRIC)
    if (sym) out.push({ sig: at(i, sym), via: 'symmetry' })
    // commuted products
    const comm = swap(t, COMMUTATIVE)
    if (comm) out.push({ sig: at(i, comm), via: 'commutativity' })
    if (t.k === 'c' && name(t) && SYMMETRIC.has(name(t)!)) {
      t.a.forEach((x, k) => {
        const c = swap(x, COMMUTATIVE)
        if (c) out.push({ sig: at(i, { ...t, a: t.a.map((y, j) => (j === k ? c : y)) }), via: 'commutativity' })
      })
    }
  }
  // currying
  let fresh = 0
  sig.args.forEach((a, i) => {
    const split = (parts: Term[]) => out.push({ sig: { ...sig, args: [...sig.args.slice(0, i), ...parts, ...sig.args.slice(i + 1)] }, via: 'currying' })
    const n = name(a)
    if (a.k === 'c' && a.a.length === 2 && n === '_*_') split(a.a)
    if (a.k === 'c' && a.a.length === 2 && n === 'Sigma') {
      const x: Term = { k: 'm', m: `h:curry${fresh++}`, a: [] }
      const [dom, fam] = a.a as [Term, Term]
      split([dom, fam.k === 'l' ? instantiate(fam.b, x) : fam.k === 'c' || fam.k === 'm' ? { ...fam, a: [...fam.a, x] } : { k: 'w' }])
    }
  })
  // and back
  if (times) {
    for (let i = 0; i + 1 < sig.args.length; i++) {
      const merged: Term = { k: 'c', id: times, a: [sig.args[i]!, sig.args[i + 1]!] }
      out.push({ sig: { ...sig, args: [...sig.args.slice(0, i), merged, ...sig.args.slice(i + 2)] }, via: 'currying' })
    }
  }
  // skip identity swaps
  const same = (a: Term, b: Term) => termKey(a) === termKey(b)
  const identity = (s: Sig) => s.args.some(a => same(a, s.res))
  return out.filter(v => v.via !== 'symmetry' || identity(sig) || !identity(v.sig))
}

// constants as written
const constNames = (q: Query, envNames: Env['names']): Map<Set<string>, string> => {
  const out = new Map<Set<string>, string>()
  for (const ids of q.consts) {
    for (const ns of envNames.values()) {
      const n = ns.find(n => [...ids].every(id => n.ids.has(id)) && n.ids.size > 0)
      if (n) {
        out.set(ids, n.name)
        break
      }
    }
  }
  return out
}

const done = (into: Map<string, Scored>): Hit[] =>
  [...into.values()].sort((a, b) => a.score - b.score).slice(0, LIMIT).map(s => ({ ...hit(s.doc, s.via), ...(s.match ? { match: s.match } : {}) }))

// ⊢ conclusions only
const CONCLUSION = /^\s*(\|-|⊢)\s*/

// split filters at top-level commas
export const splitParts = (q: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < q.length; i++) {
    const ch = q[i]!
    if ('({⦃'.includes(ch)) depth++
    else if (')}⦄'.includes(ch)) depth--
    else if (ch === ',' && depth === 0 && /\s/.test(q[i + 1] ?? ' ') && !/\s/.test(q[i - 1] ?? ' ')) {
      parts.push(q.slice(start, i))
      start = i + 1
    }
  }
  parts.push(q.slice(start))
  return parts.map(p => p.trim()).filter(Boolean)
}

// all parts hold
const conjunction = async (parts: string[], filter: string, lib: string, deadline: number, into: Map<string, Scored>): Promise<void> => {
  const strings = parts.filter(p => /^".+"$/.test(p)).map(p => ascii(p.slice(1, -1)).toLowerCase())
  const patterns: { qs: { q: Query, qt: QueryTypes }[], only: boolean, clause: string }[] = []
  const missing = new Set<string>()
  for (const p of parts.filter(p => !/^".+"$/.test(p))) {
    const conclusionOnly = CONCLUSION.test(p)
    const { toks, env: e } = await resolve(p.replace(CONCLUSION, ''), lib)
    const qs = parse(toks, e).map(x => readQuery(x, e)).filter((x): x is Query => x !== null).map(x => canonical(x, lib)).filter(x => x.unknown.length === 0)
    if (qs.length === 0) return
    await loadSignatures(qs.flatMap(q => q.consts.flatMap(ids => [...ids])))
    // any reading
    const clauses = [...new Set(qs.map(constClause))]
    const clause = clauses.some(c => !c) ? '' : clauses.length === 1 ? clauses[0]! : `(${clauses.map(c => `(${c})`).join(' | ')})`
    patterns.push({ qs: qs.map(q => ({ q, qt: { declared: q.declared ?? new Map<string, Term>(), rigid: rigidTypes(), unfold: unfolderOf(filter), missing } })), only: conclusionOnly, clause })
  }
  const clause = [...strings.map(s => `@key:{*${tag(s)}*}`), ...patterns.map(p => p.clause)].filter(Boolean).join(' ')
  await scan(clause, filter, deadline, (d, retry) => {
    const cs = docSigs(d)
    missing.clear()
    let total = 0
    for (const { qs, only } of patterns) {
      // bare names need mentioning
      if (qs.some(({ q }) => q.sig.args.length === 0 && q.sig.res.k === 'c' && q.sig.res.a.length === 0)) continue
      let best: number | null = null
      for (const { q, qt } of qs) {
        for (const c of cs) {
          let score: number | null
          try {
            const at = matchConclusion(q.sig, c, qt)?.score ?? null
            const s = at ?? (only ? null : matchAnywhere(q.sig, c)?.score ?? null)
            score = s === null ? null : at !== null ? s : s + 3
          } catch (err) {
            if (!(err instanceof TooBig)) throw err
            score = null
          }
          if (score !== null && (best === null || score < best)) best = score
        }
      }
      if (best === null) return
      total += best
    }
    // retry with signatures
    if (!retry && missing.size > 0) return true
    into.set(d.key!, { score: total * 1000 + Number(d.size ?? 0) + (d.c ? 500 : 0), doc: d })
  })
}

const typeIn = async (q: string, filter: string, lib: string, deadline: number, into: Map<string, Scored>): Promise<void> => {
  const conclusionOnly = CONCLUSION.test(q)
  const { toks, env: e } = await resolve(q.replace(CONCLUSION, ''), lib)
  const queries = parse(toks, e).map(p => readQuery(p, e)).filter((x): x is Query => x !== null).map(p => canonical(p, lib)).filter(x => x.unknown.length === 0 && x.sig.args.length <= MAX_ARGS)
  // bare variables match everything
  const useful = queries.filter(x => x.consts.length > 0 || x.sig.args.length > 0 || x.sig.res.k !== 'm')
  if (useful.length === 0) return
  const found = new Map<string, Scored>()
  const sigs = useful.filter(x => x.sig.args.length > 0)
  const bare = useful.filter(x => x.sig.args.length === 0)
  await run(sigs.map(x => ({ q: x })), 'sig', filter, deadline, found)
  await run(bare.map(x => ({ q: x })), 'conclusion', filter, deadline, found)
  // fallbacks
  const good = () => [...found.values()].filter(f => f.score < GOOD).length
  if (!conclusionOnly && bare.length > 0 && good() < FALLBACK_BELOW) await run(bare.map(x => ({ q: x })), 'anywhere', filter, deadline, found, new Set(found.keys()))
  // no rewrites for bare variables
  if (good() < FALLBACK_BELOW && useful.some(x => x.consts.length > 0)) {
    const more = new Map<string, Scored>()
    const times = e.names.get('_*_')?.find(n => n.name === '_*_')?.ids
    for (const x of useful) {
      const names = constNames(x, e.names)
      const vs = variants(x.sig, names, times).map(v => ({ q: { ...x, sig: v.sig, consts: x.consts }, via: v.via, asked: x.sig }))
      await run(vs, x.sig.args.length > 0 || vs.some(v => v.q.sig.args.length > 0) ? 'sig' : 'conclusion', filter, deadline, more)
    }
    // rewrite cost
    for (const [k, m] of more) {
      const score = m.score + REWRITE
      if (!found.has(k) || score < found.get(k)!.score) found.set(k, { ...m, score })
    }
  }
  for (const [k, v] of found) into.set(k, v)
}

// per-library parse
export const searchType = async (q: string, filter = ''): Promise<Hit[]> => {
  if (q.length > MAX_QUERY) return []
  const parts = splitParts(q)
  const into = new Map<string, Scored>()
  await slices(scoped(filter), async (lib, deadline) => {
    const f = withFilter(tags('lib', [lib]), filter)
    await (parts.length > 1 ? conjunction(parts, f, lib, deadline, into) : typeIn(q, f, lib, deadline, into))
  })
  return done(into)
}

// unknown words, parse status
// query size cap
const MAX_QUERY_NODES = 500

// query, or null past the budget
const readQuery = (x: Parsed, e: Env): Query | null => {
  try {
    const q = toQuery(x, e)
    return larger(q.sig, MAX_QUERY_NODES) ? null : q
  } catch (err) {
    if (err instanceof TooBig) return null
    throw err
  }
}

export const diagnose = async (q: string, filter = ''): Promise<{ unknown: string[], parsed: boolean, complex?: boolean }> => {
  let parsed = false
  let unknown = null as Set<string> | null
  for (const lib of scoped(filter)) {
    const here = new Set<string>()
    for (const p of splitParts(q).filter(p => !/^".+"$/.test(p))) {
      const { toks, env: e } = await resolve(p.replace(CONCLUSION, ''), lib)
      const parses = parse(toks, e)
      const qs = parses.map(x => readQuery(x, e)).filter((x): x is Query => x !== null)
      if (parses.length > 0 && qs.length === 0) return { unknown: [], parsed: true, complex: true }
      if (qs.length > 0) parsed = true
      // unknown in every reading
      const words = qs.map(x => new Set(x.unknown))
      for (const w of words[0] ?? []) if (words.every(s => s.has(w))) here.add(w)
    }
    unknown = unknown ? new Set([...unknown].filter(w => here.has(w))) : here
  }
  return { unknown: [...unknown ?? []], parsed }
}

// display

// source link
export const urlFor = ({ entry, lib }: Hit): string => {
  if (lib.source) {
    const path = `${entry.file.replace(/\./g, '/')}.agda${entry.line > 0 ? `#L${entry.line}` : ''}`
    const base = entry.file.startsWith('Agda.') && lib.agda ? `https://github.com/agda/agda/blob/v${lib.agda}/src/data/lib/prim/` : lib.source
    return `${base.replace(/\/?$/, '/')}${path}`
  }
  return lib.url ? `${lib.url.replace(/\/?$/, '/')}${entry.file}.html#${entry.pos}` : ''
}

const PRIMES = ['', "'", "''", "'''"]

const tokenize = (s: string): string[] => s.match(/[(){}⦃⦄]|[^\s(){}⦃⦄]+/g) ?? []

// display cleanup
export const displayType = (type: string, lib = ''): string => {
  let t = type.replace(/\{[^{}:]+: Level\}\s*(→\s*)?/g, '')
  const used = new Set(tokenize(t))
  // only binders, so Inverse.from keeps its qualifier
  const bound = new Set([...type.matchAll(/[{(⦃]([^{}()⦃⦄:]+):/g)].flatMap(m => m[1]!.trim().split(/\s+/)))
  const renames = new Map<string, string>()
  for (const tok of used) {
    if (!bound.has(tok)) continue
    const m = /^[^.\s]+\.\.?([^.\s]*)$/u.exec(tok)
    if (!m) continue
    const base = !m[1] || /^\d+$/.test(m[1]) ? 'ℓ' : m[1]
    const fresh = PRIMES.map(p => base + p).find(n => !used.has(n) && ![...renames.values()].includes(n))
    if (fresh) renames.set(tok, fresh)
  }
  if (renames.size > 0) t = tokenize(t).map(tok => renames.get(tok) ?? tok).join(' ')
  if (lib === 'cubical') t = t.replace(/\bSet\b/g, 'Type')
  return t.replace(/([({⦃]) /g, '$1').replace(/ ([)}⦄])/g, '$1').replace(/\s+/g, ' ').trim()
}

