import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

// one definition from AgdaIndex.hs
export interface AgdaEntry {
  name: string
  module: string
  file: string
  kind: string
  type: string
  nf?: string | null
  line: number
  pos: number
  // from a module application
  copy?: boolean
}

export interface IndexFile {
  meta: { library: string, commit: string, url: string, source?: string, agda?: string }
  entries: AgdaEntry[]
}

export interface Library {
  name: string
  commit: string
  url: string
  // sources at the indexed commit
  source: string
  agda: string
  count: number
}

export interface Hit {
  entry: AgdaEntry
  lib: Library
  // rewrite a fallback hit needed
  via?: string
}

interface Doc extends Hit {
  // ascii, lowercased, for name search
  key: string
}

let docs: Doc[] = []
let libs: Library[] = []
let byName = new Map<string, number[]>()
// type tokens, and those only in the unfolded spine
let byToken = new Map<string, number[]>()
let byNfToken = new Map<string, number[]>()
// type names like S¹ that look like variables
let concreteNames = new Set<string>()
// doc ids, shortest type first
let shortFirst: number[] = []

export const libraries = (): Library[] => libs
export const indexSize = (): number => docs.length

const push = <K>(map: Map<K, number[]>, key: K, id: number) => {
  const list = map.get(key)
  if (!list) map.set(key, [id])
  else if (list[list.length - 1] !== id) list.push(id)
}

// ascii folding

const SYMBOLS: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '↦': '|->',
  '≡': '=', '≢': '/=', '≃': '~=', '≅': '=~', '≈': '~~', '∼': '~', '≟': '=?',
  '×': '*', '⊎': '|+|', 'Σ': 'Sigma', 'Π': 'Pi', '∥': '||', '∙': '.', '∘': '.', '⊔': '\\/',
  '≤': '<=', '≥': '>=', '¬': '~', '∀': 'forall', '∃': 'exists', 'λ': '\\',
  '⊤': 'Top', '⊥': 'Bot', '∈': '<-', '∉': '/<-', '∷': '::', '⟨': '<', '⟩': '>', '∞': 'inf',
  '∧': '/\\', '∨': '\\/', '⊆': '<:=', '⊂': '<:', '∪': '\\/', '∩': '/\\', '⋆': '*', '·': '.',
  '⁻': '-', '−': '-', '′': "'", '″': "''"
}

// canonical spellings on both sides
const SYNONYMS: Record<string, string> = { Type: 'Set', N: 'Nat', Z: 'Int', 'Sigma-syntax': 'Sigma', 'exists-syntax': 'exists' }

export const ascii = (s: string): string =>
  [...s.normalize('NFKC')].map(ch => SYMBOLS[ch] ?? ch).join('')

const canon = (t: string): string => SYNONYMS[t] ?? (/^(Set|Type)[\dω]+$/.test(t) ? 'Set' : t)

const tokenize = (s: string): string[] => s.match(/[(){}⦃⦄]|[^\s(){}⦃⦄]+/g) ?? []

const NOISE = /^[(){}⦃⦄:]$|^->$|^\\$|^Set$|^Level$/

const tokensOf = (type: string): Set<string> => new Set(tokenize(ascii(type)).map(canon).filter(t => !NOISE.test(t)))

// source line at the indexed commit, else the html listing
export const urlFor = ({ entry, lib }: Hit): string => {
  if (lib.source) {
    const path = `${entry.file.replace(/\./g, '/')}.agda${entry.line > 0 ? `#L${entry.line}` : ''}`
    const base = entry.file.startsWith('Agda.') && lib.agda ? `https://github.com/agda/agda/blob/v${lib.agda}/src/data/lib/prim/` : lib.source
    return `${base.replace(/\/?$/, '/')}${path}`
  }
  return lib.url ? `${lib.url.replace(/\/?$/, '/')}${entry.file}.html#${entry.pos}` : ''
}

const TYPE_KINDS = new Set(['data', 'record', 'prim', 'postulate'])

const validEntry = (e: AgdaEntry): boolean =>
  Boolean(e) && typeof e.name === 'string' && typeof e.module === 'string' && typeof e.file === 'string' &&
  typeof e.type === 'string' && typeof e.pos === 'number' && (e.nf == null || typeof e.nf === 'string')

// swaps in only once every file is read
export const setIndex = (files: IndexFile[]) => {
  const next = { docs: [] as Doc[], libs: [] as Library[], byName: new Map<string, number[]>(), byToken: new Map<string, number[]>(), byNfToken: new Map<string, number[]>(), concrete: new Set<string>(['I']) }
  // builtins ship with both libraries
  const builtins = new Set<string>()
  for (const file of files) {
    if (!file || typeof file !== 'object' || !file.meta || typeof file.meta.library !== 'string' || !Array.isArray(file.entries)) {
      throw new Error(`malformed index file${typeof file?.meta?.library === 'string' ? ` for ${file.meta.library}` : ''}`)
    }
    const { meta, entries } = file
    const lib: Library = { name: meta.library, commit: String(meta.commit ?? ''), url: String(meta.url ?? ''), source: String(meta.source ?? ''), agda: String(meta.agda ?? ''), count: 0 }
    next.libs.push(lib)
    for (const entry of entries) {
      if (!validEntry(entry)) continue
      if (entry.module.startsWith('Agda.')) {
        const key = `${entry.module}.${entry.name}`
        if (builtins.has(key)) continue
        builtins.add(key)
      }
      const id = next.docs.length
      const name = ascii(entry.name)
      next.docs.push({ entry, lib, key: name.toLowerCase() })
      lib.count++
      push(next.byName, name, id)
      // _++_ is also found as ++
      const bare = name.replace(/_/g, '')
      if (bare && bare !== name) push(next.byName, bare, id)
      if (TYPE_KINDS.has(entry.kind) && (name !== entry.name || /\d/.test(name))) next.concrete.add(name)
      const written = tokensOf(entry.type)
      for (const t of written) push(next.byToken, t, id)
      if (entry.nf) for (const t of tokensOf(entry.nf)) if (!written.has(t)) push(next.byNfToken, t, id)
    }
  }
  ;({ docs, libs, byName, byToken, byNfToken } = next)
  concreteNames = next.concrete
  shortFirst = docs.map((_, id) => id).sort((a, b) => docs[a]!.entry.type.length - docs[b]!.entry.type.length)
}

const FETCH_MS = 60_000

// url or path, .gz gunzipped
export const loadIndex = async (sources: string[]): Promise<void> => {
  const files: IndexFile[] = []
  for (const src of sources) {
    let raw: Buffer
    if (/^https?:/.test(src)) {
      const response = await fetch(src, { signal: AbortSignal.timeout(FETCH_MS) })
      if (!response.ok) throw new Error(`${src}: ${response.status}`)
      raw = Buffer.from(await response.arrayBuffer())
    } else raw = await readFile(src)
    files.push(JSON.parse((src.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')))
  }
  setIndex(files)
}

// signatures

interface Sig {
  args: string[][]
  result: string[]
  vars: Set<string>
}

const OPEN: Record<string, true> = { '(': true, '{': true, '⦃': true }
const CLOSE: Record<string, true> = { ')': true, '}': true, '⦄': true }

// index of the bracket closing toks[i]
const group = (toks: string[], i: number): number => {
  let depth = 0
  for (let j = i; j < toks.length; j++) {
    if (OPEN[toks[j]!]) depth++
    else if (CLOSE[toks[j]!]) depth--
    if (depth === 0) return j
  }
  return toks.length - 1
}

// splits at top-level occurrences of sep
const splitTop = (toks: string[], sep: string): string[][] => {
  const parts: string[][] = [[]]
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    if (OPEN[t]) {
      const j = group(toks, i)
      parts[parts.length - 1]!.push(...toks.slice(i, j + 1))
      i = j
    } else if (t === sep) parts.push([])
    else parts[parts.length - 1]!.push(t)
  }
  return parts
}

const SYMBOLIC = /^[^\p{L}\p{N}[\]]+$/u

const operand = (t: string | undefined): boolean => t === undefined || SYMBOLIC.test(t)

const RELATIONS = new Set(['->', '=', '/=', '~=', '=~', '~~', '<->', '=>', '<=', '>=', '<', '>', ':'])

// relations at bracket depth 0
const topLevel = (toks: string[], keep: (t: string) => boolean): number[] => {
  const found: number[] = []
  for (let i = 0; i < toks.length; i++) {
    if (OPEN[toks[i]!]) i = group(toks, i)
    else if (keep(toks[i]!)) found.push(i)
  }
  return found
}

// drops levels and redundant brackets
const tidy = (toks: string[]): string[] => {
  const out: string[] = []
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!
    out.push(t)
    if (t === 'Set') {
      const next = toks[i + 1]
      if (next === '(') i = group(toks, i + 1)
      else if (next && !CLOSE[next] && next !== '->') i++
    }
  }
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== '(') continue
    const j = group(out, i)
    const inner = out.slice(i + 1, j)
    const whole = i === 0 && j === out.length - 1
    if (whole || j === i + 2 || (operand(out[i - 1]) && operand(out[j + 1]) && topLevel(inner, t => RELATIONS.has(t)).length === 0)) {
      out.splice(j, 1)
      out.splice(i--, 1)
    }
  }
  return out
}

// irrelevance and quantity marks
const MARKS = /^(\.|@0|@ω|@w|@erased|@irr|@irrelevant|@shape-irrelevant|@plenty)$/

const isName = (t: string): boolean => !OPEN[t] && !CLOSE[t] && !SYMBOLIC.test(t)

// queries drop sort binders
const parseSig = (toks: string[], query = false): Sig => {
  const vars = new Set<string>()
  const args: string[][] = []
  // false for an ordinary argument
  const binder = (g: string[]): boolean => {
    const inner = g.slice(1, -1)
    const parts = splitTop(inner, ':')
    if (parts.length < 2) {
      if (g[0] !== '{' || inner.length === 0 || !inner.every(isName)) return false
      inner.forEach(n => vars.add(n))
      return true
    }
    const names = parts[0]!.filter(n => !MARKS.test(n))
    names.forEach(n => vars.add(n))
    const ty = tidy(parts.slice(1).flat())
    const sort = ty.length === 1 && (ty[0] === 'Set' || ty[0] === 'Level')
    if (g[0] === '(' && !(query && sort)) for (let k = 0; k < names.length; k++) args.push(ty)
    return true
  }
  let rest = toks
  // name : type
  if (rest.length > 2 && rest[1] === ':' && isName(rest[0]!)) rest = rest.slice(2)
  for (;;) {
    while (rest[0] && MARKS.test(rest[0])) rest = rest.slice(1)
    const t = rest[0]
    if (t === 'forall') {
      // ∀ x {y} (z : A) →
      let i = 1
      for (; i < rest.length && rest[i] !== '->'; i++) {
        const u = rest[i]!
        if (OPEN[u]) {
          const j = group(rest, i)
          binder(rest.slice(i, j + 1))
          i = j
        } else if (!MARKS.test(u)) vars.add(u)
      }
      rest = rest.slice(i + 1)
      continue
    }
    if (t && OPEN[t]) {
      const j = group(rest, 0)
      if (binder(rest.slice(0, j + 1))) {
        rest = rest.slice(j + 1)
        if (rest[0] === '->') rest = rest.slice(1)
        continue
      }
    }
    const parts = splitTop(rest, '->')
    if (parts.length === 1) break
    args.push(tidy(parts[0]!))
    rest = rest.slice(parts[0]!.length + 1)
  }
  return { args, result: tidy(rest), vars }
}

const sigOf = (type: string): Sig => parseSig(tokenize(ascii(type)).map(canon))

// longest first, _≡_ kept whole
const OPERATORS = /<->|\|->|->|<-|=>|\/<-|\/=|~=|=~|~~|<:=|<:|<=|>=|=\?|==?|\|\+\||\*/g

const spaceOperators = (s: string): string =>
  s.replace(OPERATORS, (op: string, at: number) => (s[at - 1] === '_' || s[at + op.length] === '_' ? op : ` ${op === '==' ? '=' : op} `))

// Σ[ x ∈ A ] B as Σ A (λ x → B)
const sigmaSyntax = (toks: string[]): string[] => {
  const i = toks.findIndex(t => t === 'Sigma[' || t === 'exists[')
  const close = toks.indexOf(']', i)
  const bind = toks.slice(i + 1, close)
  const sep = bind.findIndex(t => t === '<-' || t === ':')
  if (i < 0 || close < 0 || sep < 1) return toks
  let j = close + 1
  for (let depth = 0; j < toks.length; j++) {
    const t = toks[j]!
    if (OPEN[t]) depth++
    else if (CLOSE[t]) {
      if (depth === 0) break
      depth--
    } else if (depth === 0 && t === '->') break
  }
  return sigmaSyntax([...toks.slice(0, i), toks[i]!.slice(0, -1), ...asArg(bind.slice(sep + 1)), '(', '\\', ...bind.slice(0, sep), '->', ...toks.slice(close + 1, j), ')', ...toks.slice(j)])
}

// unspaced operators, ||A||, pasted name : type
const querySig = (q: string): Sig =>
  parseSig(sigmaSyntax(tokenize(spaceOperators(ascii(q.replace(/^\s*[^\s(){}⦃⦄:]+\s+:\s+/, ''))
    .replace(/\|\|([^|]+)\|\|(\d)?/g, (_m, inner: string, n?: string) => ` || ${inner.trim()} ||${n ?? '1'} `))).map(canon)), true)

// matching with variables on both sides

type Subst = Map<string, string[]>

const MAX_STEPS = 4000

// A, x', f1, or an undefined word like xs
const isQueryVar = (t: string): boolean =>
  t === '_' || (/^\p{L}[\d']*$/u.test(t) && !concreteNames.has(t)) || (/^\p{Ll}[\p{L}\d']*$/u.test(t) && !byName.has(t))

const startsWith = (xs: string[], prefix: string[]): boolean => prefix.every((p, i) => xs[i] === p)

// length of the leading name or group, 0 for an operator
const atom = (xs: string[]): number => {
  const t = xs[0]!
  if (OPEN[t]) return group(xs, 0) + 1
  if (t === '||') return xs.findIndex((x, k) => k > 0 && /^\|\|\d*$/.test(x)) + 1
  return CLOSE[t] || SYMBOLIC.test(t) ? 0 : 1
}

// variables bind one atom, or the whole run when alone
const matchSeq = (q: string[], c: string[], qv: (t: string) => boolean, cv: Set<string>, s: Subst, budget: { steps: number }, whole = false): Subst | null => {
  if (--budget.steps < 0) return null
  if (q.length === 0) return c.length === 0 ? s : null
  if (c.length === 0) return null
  const qh = q[0]!
  const ch = c[0]!
  if (qv(qh)) {
    const key = `q:${qh}`
    const bound = qh === '_' ? undefined : s.get(key)
    if (bound) return startsWith(c, bound) ? matchSeq(q.slice(1), c.slice(bound.length), qv, cv, s, budget) : null
    const n = whole && q.length === 1 ? c.length : atom(c)
    if (n === 0 || n > c.length - (q.length - 1)) return null
    return matchSeq(q.slice(1), c.slice(n), qv, cv, qh === '_' ? s : new Map(s).set(key, c.slice(0, n)), budget)
  }
  if (cv.has(ch)) {
    const key = `c:${ch}`
    const bound = s.get(key)
    if (bound) return startsWith(q, bound) ? matchSeq(q.slice(bound.length), c.slice(1), qv, cv, s, budget) : null
    const n = atom(q)
    if (n === 0 || n > q.length - (c.length - 1) || q.slice(0, n).some(qv)) return null
    return matchSeq(q.slice(n), c.slice(1), qv, cv, new Map(s).set(key, q.slice(0, n)), budget)
  }
  return qh === ch ? matchSeq(q.slice(1), c.slice(1), qv, cv, s, budget) : null
}

// lower is better; null when the query doesn't fit
const scoreSig = (q: Sig, c: Sig): number | null => {
  if (q.args.length > c.args.length) return null
  const budget = { steps: MAX_STEPS }
  const qv = (t: string) => q.vars.has(t) || isQueryVar(t)
  // bare variable results like rec's P
  if (c.result.length === 1 && c.vars.has(c.result[0]!) && q.result.some(t => !qv(t))) return null
  const result = matchSeq(q.result, c.result, qv, c.vars, new Map(), budget, true)
  if (!result) return null
  // arguments in any order
  const offset = c.args.length - q.args.length
  let best: number | null = null
  const used = new Set<number>()
  const go = (i: number, s: Subst, moved: number) => {
    if (budget.steps < 0) return
    if (i === q.args.length) {
      // more general candidates first, like hoogle
      let specialised = 0
      for (const [key, run] of s) if (key.startsWith('q:') && !(run.length === 1 && c.vars.has(run[0]!))) specialised++
      const score = offset * 2 + moved + specialised
      if (best === null || score < best) best = score
      return
    }
    for (let k = 0; k < c.args.length; k++) {
      if (used.has(k)) continue
      const r = matchSeq(q.args[i]!, c.args[k]!, qv, c.vars, s, budget, true)
      if (!r) continue
      used.add(k)
      go(i + 1, r, moved + (k === i + offset ? 0 : 1))
      used.delete(k)
    }
  }
  go(0, result, 0)
  return best
}

// searches

const LIMIT = 200

const hit = ({ entry, lib }: Doc): Hit => ({ entry, lib })

// copies last
const tiebreak = (d: Doc): number => d.entry.name.length + d.entry.module.length / 100 + (d.entry.copy ? 50 : 0)

const plainModule = (m: string): string => m.split('.').filter(p => p !== '_').join('.')

const lookupIn = (name: string, quals: string[]): Hit[] => {
  const qual = ascii(quals.join('.'))
  let found = (byName.get(ascii(name)) ?? []).map(id => docs[id]!).filter(d => {
    const m = ascii(plainModule(d.entry.module))
    return !qual || m === qual || `${m}.`.endsWith(`.${qual}.`)
  })
  // a full module name means that module
  if (qual && found.some(d => ascii(plainModule(d.entry.module)) === qual)) found = found.filter(d => ascii(plainModule(d.entry.module)) === qual)
  // prefer the name as typed, _∙_ over _·_
  const typed = (d: Doc) => d.entry.name === name || d.entry.name.replace(/_/g, '') === name
  if (found.some(typed)) found = found.filter(typed)
  return found.sort((a, b) => tiebreak(a) - tiebreak(b)).map(hit)
}

// exact or qualified name, split before ∙ folds to .
export const lookupName = (q: string): Hit[] => {
  const segs = q.split('.')
  for (let k = segs.length - 1; k >= 0; k--) {
    const quals = segs.slice(0, k)
    const name = segs.slice(k).join('.')
    if (!name || !quals.every(s => /^\p{L}/u.test(s))) continue
    const found = lookupIn(name, quals)
    if (found.length > 0) return found
  }
  return []
}

const subsequence = (needle: string, hay: string): boolean => {
  let i = 0
  for (const ch of hay) if (ch === needle[i]) i++
  return i === needle.length
}

export const searchNames = (q: string): Hit[] => {
  const terms = ascii(q).toLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return []
  const scored: [number, Doc][] = []
  for (const d of docs) {
    let score = 0
    for (const t of terms) {
      if (d.key === t) continue
      else if (d.key.startsWith(t)) score += 1
      else if (d.key.includes(t)) score += 2
      else if (ascii(d.entry.module).toLowerCase().includes(t)) score += 3
      else if (subsequence(t, d.key)) score += 5
      else {
        score = -1
        break
      }
    }
    if (score >= 0) scored.push([score * 100 + tiebreak(d), d])
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, LIMIT).map(([, d]) => hit(d))
}

// mixfix names match by their parts, ||_||1 needs || and ||1
const parts = (id: string): string[] => ascii(id).split('_').filter(Boolean).map(canon)

// docs mentioning every token, counting unfolded-only ones
const mentioning = (tokens: string[]): Map<number, number> | null => {
  if (tokens.length === 0) return null
  let found: Map<number, number> | null = null
  for (const t of tokens) {
    const next = new Map<number, number>()
    for (const id of byToken.get(t) ?? []) if (!found || found.has(id)) next.set(id, found?.get(id) ?? 0)
    for (const id of byNfToken.get(t) ?? []) if (!found || found.has(id)) next.set(id, (found?.get(id) ?? 0) + 1)
    found = next
  }
  return found
}

// definitions whose type mentions every id, -id excludes
export const searchAbout = (q: string): Hit[] => {
  const ids = q.split(/\s+/).filter(Boolean)
  const include = ids.filter(id => !id.startsWith('-')).flatMap(parts)
  const exclude = new Set(ids.filter(id => id.startsWith('-') && id.length > 1).flatMap(id => parts(id.slice(1))))
  const found = mentioning(include)
  if (!found) return []
  const scored: [number, Doc][] = []
  for (const [id, viaNf] of found) {
    const d = docs[id]!
    if (exclude.size > 0 && [...tokensOf(d.entry.type)].some(t => exclude.has(t))) continue
    scored.push([viaNf * 1000 + d.entry.type.length + d.entry.name.length, d])
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, LIMIT).map(([, d]) => hit(d))
}

// up to isomorphism, when exact matches are few

const FALLBACK_BELOW = 5
// time budget, bare-variable queries scan everything
const SEARCH_MS = 300
const MAX_ARGS = 8
export const MAX_QUERY = 300

const SYMMETRIC = new Set(['=', '~=', '=~', '<->'])
const COMMUTATIVE = new Set(['*', '|+|'])

interface Variant {
  sig: Sig
  via: string
}

// sides of the one top-level op swapped
const swapOp = (toks: string[], ops: Set<string>): string[] | null => {
  const at = topLevel(toks, t => ops.has(t))
  if (at.length !== 1) return null
  const i = at[0]!
  return [...toks.slice(i + 1), toks[i]!, ...toks.slice(0, i)]
}

// head applied to exactly two atoms
const twoAtoms = (toks: string[], head: string): [string[], string[]] | null => {
  if (toks[0] !== head || toks.length < 3) return null
  const n = atom(toks.slice(1))
  if (n === 0 || n >= toks.length - 1 || atom(toks.slice(1 + n)) !== toks.length - 1 - n) return null
  return [toks.slice(1, 1 + n), toks.slice(1 + n)]
}

// as tidy leaves them
const asArg = (toks: string[]): string[] => (atom(toks) === toks.length ? toks : ['(', ...toks, ')'])
const asOperand = (toks: string[]): string[] => (topLevel(toks, t => RELATIONS.has(t)).length > 0 ? ['(', ...toks, ')'] : toks)

const variants = (q: Sig): Variant[] => {
  const out: Variant[] = []
  const at = (i: number, toks: string[]): Sig => (i < 0 ? { ...q, result: toks } : { ...q, args: q.args.map((a, k) => (k === i ? toks : a)) })
  const positions: [number, string[]][] = [[-1, q.result], ...q.args.map((a, i) => [i, a] as [number, string[]])]
  for (const [i, toks] of positions) {
    // x ≡ y as y ≡ x, Iso A B as Iso B A
    const iso = twoAtoms(toks, 'Iso')
    const sym = swapOp(toks, SYMMETRIC) ?? (iso && ['Iso', ...iso[1], ...iso[0]])
    if (sym) out.push({ sig: at(i, sym), via: 'symmetry' })
    // A × B as B × A
    const comm = swapOp(toks, COMMUTATIVE)
    if (comm) out.push({ sig: at(i, comm), via: 'commutativity' })
  }
  // Σ A B → C as (a : A) → B a → C, A × B → C as A → B → C
  q.args.forEach((a, i) => {
    const split = (parts: string[][]) => out.push({ sig: { ...q, args: [...q.args.slice(0, i), ...parts, ...q.args.slice(i + 1)] }, via: 'currying' })
    const times = topLevel(a, t => t === '*')
    if (times.length === 1) split([a.slice(0, times[0]), a.slice(times[0]! + 1)])
    const sigma = twoAtoms(a, 'Sigma')
    if (sigma && sigma[1].length === 1) split([sigma[0], [...sigma[1], '_']])
  })
  // and back
  for (let i = 0; i + 1 < q.args.length; i++) {
    const [x, y] = [q.args[i]!, q.args[i + 1]!]
    const merge = (arg: string[]) => out.push({ sig: { ...q, args: [...q.args.slice(0, i), arg, ...q.args.slice(i + 2)] }, via: 'currying' })
    merge([...asOperand(x), '*', ...asOperand(y)])
    const family = y.slice(0, -1)
    if (y.length >= 2 && isQueryVar(y[y.length - 1]!) && atom(family) === family.length) merge(['Sigma', ...asArg(x), ...family])
  }
  // skip swaps that only find identities
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((t, k) => t === b[k])
  const identity = (sig: Sig) => sig.args.some(a => same(a, sig.result))
  return out.filter(v => v.via !== 'symmetry' || identity(q) || !identity(v.sig))
}

// doc id to score; concrete is false for a full scan
const rank = (query: Sig, deadline: number): { scored: Map<number, number>, concrete: boolean } => {
  const concrete = [...new Set([...query.args.flat(), ...query.result])].filter(t => !isQueryVar(t) && !query.vars.has(t) && !NOISE.test(t))
  const found = mentioning(concrete)
  const ids = found ? [...found.keys()].sort((a, b) => docs[a]!.entry.type.length - docs[b]!.entry.type.length) : shortFirst
  const scored = new Map<number, number>()
  for (let k = 0; k < ids.length; k++) {
    if ((k & 127) === 0 && performance.now() > deadline) break
    const id = ids[k]!
    const d = docs[id]!
    let best: number | null = null
    for (const [type, unfolded] of [[d.entry.type, 0], [d.entry.nf, 1]] as const) {
      if (!type) continue
      const score = scoreSig(query, sigOf(type))
      // unfolded matches rank lower
      if (score !== null && (best === null || score + unfolded < best)) best = score + unfolded
    }
    if (best !== null) scored.set(id, best * 1000 + d.entry.type.length + (d.entry.copy ? 500 : 0))
  }
  return { scored, concrete: found !== null }
}

export const searchType = (q: string): Hit[] => {
  if (q.length > MAX_QUERY) return []
  const query = querySig(q)
  if (query.result.length === 0 || query.args.length > MAX_ARGS) return []
  const deadline = performance.now() + SEARCH_MS
  const { scored, concrete } = rank(query, deadline)
  const exact = [...scored].sort((a, b) => a[1] - b[1]).slice(0, LIMIT)
  const hits = exact.map(([id]) => hit(docs[id]!))
  // no rewrites for bare-variable queries
  if (exact.length >= FALLBACK_BELOW || !concrete) return hits
  const seen = new Set(exact.map(([id]) => id))
  const more = new Map<number, [number, string]>()
  for (const { sig, via } of variants(query)) {
    for (const [id, score] of rank(sig, deadline).scored) {
      const prev = more.get(id)
      if (!seen.has(id) && (!prev || score < prev[0])) more.set(id, [score, via])
    }
  }
  const rest = [...more].sort((a, b) => a[1][0] - b[1][0]).slice(0, LIMIT - hits.length)
  return [...hits, ...rest.map(([id, [, via]]) => ({ ...hit(docs[id]!), via }))]
}

// display

const PRIMES = ['', "'", "''", "'''"]

// drops level binders, renames generated names, Type for cubical
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
