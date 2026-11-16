import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'

// one definition, as dumped by agda-index/AgdaIndex.hs
export interface AgdaEntry {
  name: string
  module: string
  file: string
  kind: string
  type: string
  nf?: string | null
  line: number
  pos: number
}

export interface IndexFile {
  meta: { library: string, commit: string, url: string }
  entries: AgdaEntry[]
}

export interface Library {
  name: string
  commit: string
  url: string
  count: number
}

export interface Hit {
  entry: AgdaEntry
  lib: Library
}

interface Doc extends Hit {
  // ascii, lowercased, for name search
  key: string
}

let docs: Doc[] = []
let libs: Library[] = []
const byName = new Map<string, number[]>()
// ascii tokens of the type as written, and of the unfolded spine only
const byToken = new Map<string, number[]>()
const byNfToken = new Map<string, number[]>()

export const libraries = (): Library[] => libs
export const indexSize = (): number => docs.length

const push = <K>(map: Map<K, number[]>, key: K, id: number) => {
  const list = map.get(key)
  if (!list) map.set(key, [id])
  else if (list[list.length - 1] !== id) list.push(id)
}

// ascii, since discord users mostly can't type unicode

const SYMBOLS: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '↦': '|->',
  '≡': '=', '≢': '/=', '≃': '~=', '≅': '=~', '≈': '~~', '∼': '~', '≟': '=?',
  '×': '*', '⊎': '|+|', 'Σ': 'Sigma', 'Π': 'Pi', '∥': '||', '∙': '.', '∘': 'o', '⊔': 'lub',
  '≤': '<=', '≥': '>=', '¬': '~', '∀': 'forall', '∃': 'exists', 'λ': '\\',
  '⊤': 'Top', '⊥': 'Bot', '∈': 'in', '∉': 'notin', '∷': '::', '⟨': '<', '⟩': '>', '∞': 'inf',
  '∧': '/\\', '∨': '\\/', '⊆': 'sub', '⊂': 'sub', '∪': 'u', '∩': 'n', '⋆': '*', '·': '.',
  '⁻': '-', '−': '-', '′': "'", '″': "''"
}

// canonical spellings on both sides
const SYNONYMS: Record<string, string> = { Type: 'Set', N: 'Nat', Z: 'Int' }

export const ascii = (s: string): string =>
  [...s.normalize('NFKC')].map(ch => SYMBOLS[ch] ?? ch).join('')

const canon = (t: string): string => SYNONYMS[t] ?? t

const tokenize = (s: string): string[] => s.match(/[(){}⦃⦄]|[^\s(){}⦃⦄]+/g) ?? []

const NOISE = /^[(){}⦃⦄:]$|^->$|^\\$|^Set$|^Level$/

const tokensOf = (type: string): Set<string> => new Set(tokenize(ascii(type)).map(canon).filter(t => !NOISE.test(t)))

// agda's html anchors are character offsets
export const urlFor = ({ entry, lib }: Hit): string =>
  lib.url ? `${lib.url.replace(/\/?$/, '/')}${entry.file}.html#${entry.pos}` : ''

// installs parsed index files, replacing whatever was loaded
export const setIndex = (files: IndexFile[]) => {
  docs = []
  libs = []
  byName.clear()
  byToken.clear()
  byNfToken.clear()
  for (const { meta, entries } of files) {
    const lib: Library = { name: meta.library, commit: meta.commit, url: meta.url, count: entries.length }
    libs.push(lib)
    for (const entry of entries) {
      const id = docs.length
      const name = ascii(entry.name)
      docs.push({ entry, lib, key: name.toLowerCase() })
      push(byName, name, id)
      // _++_ is also found as ++
      const bare = name.replace(/_/g, '')
      if (bare && bare !== name) push(byName, bare, id)
      const written = tokensOf(entry.type)
      for (const t of written) push(byToken, t, id)
      if (entry.nf) for (const t of tokensOf(entry.nf)) if (!written.has(t)) push(byNfToken, t, id)
    }
  }
}

// http(s) url or local path, gzipped if it ends in .gz
export const loadIndex = async (sources: string[]): Promise<void> => {
  const files: IndexFile[] = []
  for (const src of sources) {
    let raw: Buffer
    if (/^https?:/.test(src)) {
      const response = await fetch(src)
      if (!response.ok) throw new Error(`${src}: ${response.status}`)
      raw = Buffer.from(await response.arrayBuffer())
    } else raw = await readFile(src)
    files.push(JSON.parse((src.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')))
  }
  setIndex(files)
}

// signatures: explicit argument types and the result, implicits and levels dropped

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

// `Set ℓ` → `Set`, brackets around one token or an operator's operand dropped, (m + n) ≡ (n + m) is m + n ≡ n + m
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
    if (j === i + 2 || (operand(out[i - 1]) && operand(out[j + 1]))) {
      out.splice(j, 1)
      out.splice(i--, 1)
    }
  }
  return out
}

// takes ascii tokens
const parseSig = (toks: string[]): Sig => {
  const vars = new Set<string>()
  const args: string[][] = []
  let rest = toks
  for (;;) {
    const t = rest[0]
    if (t && OPEN[t]) {
      const j = group(rest, 0)
      const binder = splitTop(rest.slice(1, j), ':')
      if (binder.length >= 2) {
        const names = binder[0]!
        names.forEach(n => vars.add(n))
        if (t === '(') {
          const argTy = tidy(binder.slice(1).flat())
          for (let k = 0; k < names.length; k++) args.push(argTy)
        }
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

// discord queries: arrows and equations may come unspaced, ||A|| is propositional truncation
const querySig = (q: string): Sig =>
  parseSig(tokenize(ascii(q)
    .replace(/\|\|\s*(.+?)\s*\|\|(\d)?/g, (_m, inner: string, n?: string) => ` || ${inner} ||${n ?? '1'} `)
    .replace(/->/g, ' -> ')
    .replace(/(?<![~<>/=!:|])==?(?![~=>?])/g, ' = ')
    .replace(/\*/g, ' * ')
    .replace(/\bforall\b/g, ' ')).map(canon))

// matching with variables on both sides, each binding a run of tokens

type Subst = Map<string, string[]>

const MAX_STEPS = 4000

const isQueryVar = (t: string): boolean => t === '_' || /^\p{L}[\d']*$/u.test(t)

const startsWith = (xs: string[], prefix: string[]): boolean => prefix.every((p, i) => xs[i] === p)

// length of the name or bracketed group starting xs, 0 for an operator
const atom = (xs: string[]): number => {
  const t = xs[0]!
  if (OPEN[t]) return group(xs, 0) + 1
  if (t === '||') return xs.findIndex((x, k) => k > 0 && /^\|\|\d*$/.test(x)) + 1
  return CLOSE[t] || SYMBOLIC.test(t) ? 0 : 1
}

// variables bind one atom, or a query variable standing alone binds the whole run
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
  // a bare variable result like rec's P says nothing about a concrete one
  if (c.result.length === 1 && c.vars.has(c.result[0]!) && q.result.some(t => !qv(t))) return null
  const result = matchSeq(q.result, c.result, qv, c.vars, new Map(), budget, true)
  if (!result) return null
  // each query argument takes a distinct candidate argument, any order
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

const tiebreak = (d: Doc): number => d.entry.name.length + d.entry.module.length / 100

const plainModule = (m: string): string => m.split('.').filter(p => p !== '_').join('.')

// exact name, or a qualified suffix like Iso.fun or Prelude.isProp->isSet
export const lookupName = (q: string): Hit[] => {
  const parts = ascii(q).split('.')
  const name = parts.pop()!
  const found = (byName.get(name) ?? []).map(id => docs[id]!).filter(d =>
    parts.length === 0 || `${ascii(plainModule(d.entry.module))}.`.endsWith(`.${parts.join('.')}.`) || ascii(plainModule(d.entry.module)) === parts.join('.'))
  return found.sort((a, b) => tiebreak(a) - tiebreak(b)).map(hit)
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

// ids of docs mentioning every token, with how many were only in the unfolded spine
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

export const searchType = (q: string): Hit[] => {
  const query = querySig(q)
  if (query.result.length === 0) return []
  const concrete = [...new Set([...query.args.flat(), ...query.result])].filter(t => !isQueryVar(t) && !NOISE.test(t))
  const found = mentioning(concrete)
  const ids = found ? [...found.keys()] : docs.map((_, id) => id)
  const scored: [number, Doc][] = []
  for (const id of ids) {
    const d = docs[id]!
    let best: number | null = null
    for (const [type, unfolded] of [[d.entry.type, 0], [d.entry.nf, 1]] as const) {
      if (!type) continue
      const score = scoreSig(query, sigOf(type))
      // unfolded matches rank a step below types as written
      if (score !== null && (best === null || score + unfolded < best)) best = score + unfolded
    }
    if (best !== null) scored.push([best * 1000 + d.entry.type.length, d])
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, LIMIT).map(([, d]) => hit(d))
}

// display

const PRIMES = ['', "'", "''", "'''"]

// level binders dropped, generalised names like A.ℓ or y..1 renamed, Type for cubical
export const displayType = (type: string, lib = ''): string => {
  let t = type.replace(/\{[^{}:]+: Level\}\s*(→\s*)?/g, '')
  const used = new Set(tokenize(t))
  const renames = new Map<string, string>()
  for (const tok of used) {
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
