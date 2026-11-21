import { ascii } from './fold.ts'
import { apply, kept, type Sig, type Term } from './term.ts'

// query parsing

// notation element
export type El =
  | { k: 'part', part: string }
  | { k: 'hole', n: number, hidden?: boolean }
  | { k: 'bind', hole: number, v: number }

export interface Notation {
  // folded name
  name: string
  ids: Set<string>
  assoc: 'left' | 'right' | 'non'
  level: number
  // syntax declaration
  syntax?: El[]
  // alias target's explicit args
  keep?: [number[], number]
  // record constructor fields
  fields?: Set<string>[]
}

// store resolution for a query
export interface Env {
  // constants by name and fixity
  names: Map<string, Notation[]>
  // type letters, N for ℕ
  concrete: Set<string>
  // names other libraries know
  elsewhere?: Set<string>
  // builtin zero and suc
  nat?: { zero: Set<string>, suc: Set<string> }
}

const BRACKETS = /([(){}⦃⦄])/
const SPECIAL = new Set(['(', ')', '{', '}', '⦃', '⦄', '->', ':', '\\', 'forall', '_', '§', '=', ';', 'in', 'let', 'record', 'where'])
const SYMBOL_START = /^[^\p{L}\p{N}'_]/u
// irrelevance and quantity marks
const MARKS = /^(\.|\.\.|@0|@ω|@w|@erased|@irr|@irrelevant|@shape-irrelevant|@plenty|@lock|@tick|@♭|@flat)$/
// postfix projections
const PROJECTION = /^\.\.?\p{L}/u
// qualified names
const QUALIFIED = /^\p{Lu}[^.\s]*(\.[^.\s]+)+$/u
// literals
const LITERAL = /^(-?(\d[\d_]*|0x[\da-fA-F_]+|0b[01_]+)(\.\d+([eE][+-]?\d+)?)?|"([^"\\]|\\.)*"|'([^'\\]|\\.[^']*)')$/

// name : type line
const PASTED = /^\s*[^\s(){}⦃⦄:]+\s+:\s+/

// literals in one spelling
export const literal = (t: string): string => {
  if (/^["']/.test(t)) return t
  const neg = t.startsWith('-')
  const body = (neg ? t.slice(1) : t).replace(/_/g, '')
  const n = /^0[xb]/.test(body) ? BigInt(body).toString() : body
  return neg ? `-${n}` : n
}

// normalise brackets and goals
export const prepare = (q: string): string =>
  ascii(q.replace(PASTED, '').replace(/\{!.*?!\}/gs, ' ? ')).replace(/\{\{/g, ' ⦃ ').replace(/\}\}/g, ' ⦄ ')

// split at whitespace and brackets
export const chunks = (q: string): string[] =>
  prepare(q).split(/("(?:[^"\\]|\\.)*")|\s+/).filter((w): w is string => Boolean(w)).flatMap(w => (w.startsWith('"') ? [w] : w.split(BRACKETS))).filter(Boolean)

// split unknown chunks at notation parts
export const lex = (cs: string[], isName: (s: string) => boolean, parts: Set<string>): string[] => {
  const symbolic = [...parts, '->', ':'].filter(p => SYMBOL_START.test(p)).sort((a, b) => b.length - a.length)
  const prefixes = [...parts].filter(p => !SYMBOL_START.test(p) && /[^\p{L}\p{N}'_]/u.test(p)).sort((a, b) => b.length - a.length)
  const out: string[] = []
  for (const c of cs) {
    // name parts and sections
    const segs = c.split('_')
    if (!isName(c) && segs.length > 1 && segs.some(Boolean) && segs.every(p => !p || parts.has(p))) {
      segs.forEach((p, i) => {
        if (i > 0) out.push('§')
        if (p) out.push(p)
      })
      continue
    }
    if (SPECIAL.has(c) || isName(c) || parts.has(c) || /^\?/.test(c) || LITERAL.test(c) || !/[^\p{L}\p{N}'_]/u.test(c)) {
      out.push(c === '==' ? '=' : c)
      continue
    }
    if (PROJECTION.test(c) || QUALIFIED.test(c) || MARKS.test(c)) {
      out.push(c)
      continue
    }

    const pieces: string[] = []
    let word = ''
    const lead = prefixes.find(p => c.startsWith(p) && c.length > p.length)
    let i = 0
    if (lead) {
      pieces.push(lead)
      i = lead.length
    }
    while (i < c.length) {
      const p = SYMBOL_START.test(c[i]!) ? symbolic.find(s => c.startsWith(s, i)) : undefined
      if (p) {
        if (word) pieces.push(word)
        word = ''
        pieces.push(p)
        i += p.length
      } else word += c[i++]
    }
    if (word) pieces.push(word)
    const split = pieces.length > 1
    for (const p of pieces) out.push(split && p === '_' ? '§' : p)
  }
  return out
}

// syntax trees

export type Q =
  | { k: 'word', w: string }
  | { k: 'hole' }
  | { k: 'section' }
  | { k: 'meta', name: string }
  | { k: 'lit', v: string }
  | { k: 'any' }
  // holes by number, with binders
  | { k: 'op', n: Notation, args: Q[], binds: string[][], open: boolean }
  | { k: 'app', f: Q, args: Q[] }
  | { k: 'paren', e: Q }
  | { k: 'pi', names: string[] | null, hid: number, dom: Q, cod: Q, pat?: Q }
  | { k: 'lam', names: (string | null)[], body: Q }

// _+_ as hole, part, hole
const nameElements = (name: string): El[] => {
  const out: El[] = []
  let n = 0
  name.split('_').forEach((p, i) => {
    if (i > 0) out.push({ k: 'hole', n: n++ })
    if (p) out.push({ k: 'part', part: p })
  })
  return out
}

export const elementsOf = (n: Notation): El[] => n.syntax ?? nameElements(n.name)

const isOperator = (n: Notation): boolean =>
  Boolean(n.syntax) || (n.name.includes('_') && n.name !== '_' && nameElements(n.name).some(e => e.k === 'part'))

// closing parts, and : for ꞉
const partMatches = (tok: string | undefined, part: string, first: boolean): boolean =>
  tok !== undefined && (tok === part || (!first && (part === `${tok}1` || (tok === ':' && part === '꞉'))))

type Res = [Q, number][]

const MAX_RESULTS = 64
const MAX_PARSES = 8

const CLOSE: Record<string, string> = { '(': ')', '{': '}', '⦃': '⦄' }

export const parse = (toks: string[], env: Env): Q[] => {
  const ops = [...new Map([...env.names.values()].flat().filter(isOperator).map(n => [`${n.name}${n.syntax ? ' syntax' : ''}`, n])).values()]
  // notation lookup tables
  const leading = new Map<string, Notation[]>()
  const trailing = new Map<string, Notation[]>()
  const allParts = new Set<string>()
  for (const n of ops) {
    const els = elementsOf(n)
    for (const e of els) if (e.k === 'part') allParts.add(e.part)
    const first = els[0]
    const second = els[1]
    if (first?.k === 'part') leading.set(first.part, [...(leading.get(first.part) ?? []), n])
    else if (first?.k === 'hole' && second?.k === 'part') trailing.set(second.part, [...(trailing.get(second.part) ?? []), n])
  }
  // notation parts aren't names
  const partOnly = (t: string) => allParts.has(t) && (!/\p{L}/u.test(t) || (!/^\p{L}['\d]*$/u.test(t) && !(env.names.get(t) ?? []).some(n => n.name === t && !isOperator(n))))
  const memo = new Map<string, Res>()
  const cached = (key: string, f: () => Res): Res => {
    let r = memo.get(key)
    if (!r) {
      memo.set(key, [])
      r = f().slice(0, MAX_RESULTS)
      memo.set(key, r)
    }
    return r
  }
  // index past bracket group
  const skipGroup = (i: number): number | null => {
    const open = toks[i]!
    let depth = 0
    for (let j = i; j < toks.length; j++) {
      if (toks[j] === open) depth++
      else if (toks[j] === CLOSE[open]) depth--
      if (depth === 0) return j + 1
    }
    return null
  }

  interface Partial {
    args: Q[]
    binds: string[][]
  }

  // rest of a notation
  const rest = (n: Notation, els: El[], from: number, i: number, acc: Partial, operand: (i: number) => Res): Res => {
    if (from === els.length) return [[{ k: 'op', n, ...acc, open: false }, i]]
    const e = els[from]!
    if (e.k === 'part') return partMatches(toks[i], e.part, from === 0) ? rest(n, els, from + 1, i + 1, acc, operand) : []
    if (e.k === 'bind') {
      const t = toks[i]
      if (t === undefined || (SPECIAL.has(t) && t !== '_') || partOnly(t)) return []
      const binds = acc.binds.map(b => [...b])
      ;(binds[e.hole] ??= [])[e.v] = t === '_' ? '' : t
      return rest(n, els, from + 1, i + 1, { ...acc, binds }, operand)
    }
    const put = (q: Q): Partial => {
      const args = [...acc.args]
      args[e.n] = q
      return { ...acc, args }
    }
    if (from === els.length - 1) return operand(i).map(([q, j]) => [{ k: 'op', n, ...put(q), open: true }, j])
    const next = els[from + 1]!
    const ends = (j: number) => next.k !== 'part' || partMatches(toks[j], next.part, false)
    return typ(i).filter(([, j]) => ends(j)).flatMap(([q, j]) => rest(n, els, from + 1, j, put(q), operand))
  }

  const start = (): Partial => ({ args: [], binds: [] })

  const atom = (i: number): Res => cached(`a${i}`, () => {
    const t = toks[i]
    if (t === undefined) return []
    if (t === '(') {
      // drop λ ()
      if (toks[i + 1] === ')') return [[{ k: 'any' }, i + 2]]
      return typ(i + 1).filter(([, j]) => toks[j] === ')').map(([q, j]) => [{ k: 'paren', e: q }, j + 1])
    }
    if (t === '_') return [[{ k: 'hole' }, i + 1]]
    if (t === '§') return [[{ k: 'section' }, i + 1]]
    if (t.startsWith('?')) return [[t.length > 1 ? { k: 'meta', name: t.slice(1) } : { k: 'hole' }, i + 1]]
    // digits are numbers
    if (LITERAL.test(t) && (/^\d/.test(t) || !partOnly(t))) return [[{ k: 'lit', v: literal(t) }, i + 1]]
    // record expressions
    if (t === 'record') {
      const at = toks[i + 1] === '{' ? i + 1 : toks[i + 2] === '{' ? i + 2 : -1
      const end = at < 0 ? null : skipGroup(at)
      return end === null ? [] : [[{ k: 'any' }, end]]
    }
    if (SPECIAL.has(t) || PROJECTION.test(t)) return []
    const out: Res = []
    for (const n of leading.get(t) ?? []) {
      const els = elementsOf(n)
      if (els[els.length - 1]!.k !== 'hole') out.push(...rest(n, els, 1, i + 1, start(), () => []))
    }
    if (!partOnly(t)) out.push([{ k: 'word', w: t }, i + 1])
    return out
  })

  // lambdas
  const lambda = (i: number): Res => {
    // pattern lambda
    if (toks[i] === '{') {
      const end = skipGroup(i)
      if (end !== null && toks.slice(i + 1, end - 1).includes('->')) return [[{ k: 'any' }, end]]
    }
    if (toks[i] === 'where') return [[{ k: 'any' }, toks.length]]
    // λ ()
    if (toks[i] === '(' && toks[i + 1] === ')') return [[{ k: 'any' }, i + 2]]
    const go = (j: number, names: (string | null)[]): Res => {
      const t = toks[j]
      if (t === undefined) return []
      if (t === '->') return names.length > 0 ? typ(j + 1).map(([b, k]) => [{ k: 'lam', names, body: b }, k] as [Q, number]) : []
      if (CLOSE[t]) {
        const hidden = t !== '('
        const out: Res = []
        for (const [ns, , , k] of binder(j, true)) out.push(...go(k, [...names, ...ns.map(n => (hidden ? null : n))]))
        // pattern binder matches anything
        if (!hidden && toks[j + 1] === '(') {
          const end = skipGroup(j)
          if (end !== null) out.push(...go(end, [...names, '']))
        }
        return out
      }
      if (SPECIAL.has(t) && t !== '_') return []
      return go(j + 1, [...names, t])
    }
    return go(i, [])
  }

  const nud = (i: number): Res => cached(`n${i}`, () => {
    const t = toks[i]
    if (t === undefined) return []
    const out: Res = [...atom(i)]
    // irrelevant type
    if (PROJECTION.test(t)) out.push([{ k: 'word', w: t.replace(/^\.+/, '') }, i + 1])
    if (t === '\\') out.push(...lambda(i + 1))
    // let … in e
    if (t === 'let') {
      const at = toks.indexOf('in', i + 1)
      if (at > 0) out.push(...typ(at + 1).map(([, k]) => [{ k: 'any' }, k] as [Q, number]))
    }
    for (const n of leading.get(t) ?? []) {
      const els = elementsOf(n)
      if (els[els.length - 1]!.k === 'hole') out.push(...rest(n, els, 1, i + 1, start(), k => expr(k, n.level, true)))
    }
    return out
  })

  const appable = (q: Q): boolean => !(q.k === 'op' && (q.open || elementsOf(q.n)[0]!.k === 'hole')) && q.k !== 'lam'

  // operators, application, projections
  const led = (lhs: Q, j: number, min: number, eq: boolean): Res => {
    const out: Res = [[lhs, j]]
    const t = toks[j]
    if (t === undefined) return out
    const open = lhs.k === 'op' && lhs.open
    if (appable(lhs)) {
      // implicit args dropped
      if (t === '{' || t === '⦃') {
        const end = skipGroup(j)
        if (end !== null) out.push(...led(lhs, end, min, eq))
      }
      // x .fst as fst x
      if (PROJECTION.test(t) && !/^\.\./.test(t)) out.push(...led({ k: 'app', f: { k: 'word', w: t.slice(1) }, args: [lhs] }, j + 1, min, eq))
      for (const [arg, k] of atom(j)) {
        const app: Q = lhs.k === 'app' ? { k: 'app', f: lhs.f, args: [...lhs.args, arg] } : { k: 'app', f: lhs, args: [arg] }
        out.push(...led(app, k, min, eq))
      }
    }
    if (lhs.k === 'lam') return out
    for (const n of trailing.get(t) ?? []) {
      const L = n.level
      if (L < min || (L === min && !eq)) continue
      // open lhs operator
      if (open && !(L < lhs.n.level || (L === lhs.n.level && n.assoc === 'left' && lhs.n.assoc === 'left'))) continue
      const els = elementsOf(n)
      const right = (k: number) => expr(k, L, n.assoc === 'right')
      const first = els[0] as { n: number }
      const acc = start()
      acc.args[first.n] = lhs
      for (const [q, k] of rest(n, els, 2, j + 1, acc, right)) out.push(...led(q, k, min, eq))
    }
    return out
  }

  const expr = (i: number, min: number, eq: boolean): Res =>
    cached(`e${i}:${min}:${eq}`, () => nud(i).flatMap(([q, j]) => led(q, j, min, eq)))

  // binders
  type Binder = [string[], number, Q | null, number, Q?]
  let patterns = 0
  const binder = (i: number, untyped = false): Binder[] => {
    let at = i
    while (toks[at] && MARKS.test(toks[at]!)) at++
    const close = CLOSE[toks[at]!]
    if (!close) return []
    const hid = toks[at] === '(' ? 0 : toks[at] === '{' ? 1 : 2
    let j = at + 1
    const names: string[] = []
    while (toks[j] && (!SPECIAL.has(toks[j]!) || toks[j] === '_') && (MARKS.test(toks[j]!) || /^[\p{L}\p{N}'_-]+$/u.test(toks[j]!))) {
      if (!MARKS.test(toks[j]!)) names.push(toks[j]!)
      j++
    }
    // {A = X : Set} binds X
    if (hid > 0 && names.length === 1 && toks[j] === '=' && toks[j + 1] && !SPECIAL.has(toks[j + 1]!)) {
      names[0] = toks[j + 1]!
      j += 2
    }
    if (names.length === 0 || (toks[j] !== ':' && toks[j] !== close)) return patternBinder(at, close, hid)
    if (toks[j] === close && (hid > 0 || untyped)) return [[names, hid, null, j + 1]]
    if (toks[j] !== ':') return []
    return typ(j + 1).filter(([, k]) => toks[k] === close).map(([d, k]) => [names, hid, d, k + 1])
  }

  // pattern binder as fresh p
  const patternBinder = (at: number, close: string, hid: number): Binder[] => {
    if (toks[at + 1] !== '(') return []
    const end = skipGroup(at + 1)
    if (end === null || toks[end] !== ':') return []
    const name = `§p${patterns++}`
    return expr(at + 1, -Infinity, true).filter(([, k]) => k === end).flatMap(([pat]) =>
      typ(end + 1).filter(([, k]) => toks[k] === close).map(([d, k]): Binder => [[name], hid, d, k + 1, pat]))
  }

  const typ = (i: number): Res => cached(`t${i}`, () => {
    const out: Res = []
    // irrelevant or erased domain
    if (toks[i] && MARKS.test(toks[i])) out.push(...typ(i + 1))
    if (toks[i] === 'forall') {
      // ∀ binders
      const go = (j: number, acc: [string[], number, Q | null, Q?][]): Res => {
        if (toks[j] === '->') return typ(j + 1).map(([b, k]) => [acc.reduceRight<Q>((c, [names, hid, d, pat]) => ({ k: 'pi', names, hid, dom: d ?? { k: 'hole' }, cod: c, ...(pat ? { pat } : {}) }), b), k])
        const t = toks[j]
        if (t === undefined) return []
        if (MARKS.test(t)) return go(j + 1, acc)
        if (PROJECTION.test(t)) return go(j + 1, [...acc, [[t.replace(/^\.+/, '')], 0, null]])
        if (!SPECIAL.has(t) || t === '_') return go(j + 1, [...acc, [[t], 0, null]])
        return binder(j, true).flatMap(([names, hid, d, k, pat]) => go(k, [...acc, [names, hid, d, pat]]))
      }
      return go(i + 1, [])
    }
    for (const [names, hid, d, j, pat] of binder(i)) {
      if (!d && hid === 0) continue
      const cod = toks[j] === '->' ? typ(j + 1) : typ(j)
      out.push(...cod.map(([c, k]) => [{ k: 'pi', names, hid, dom: d ?? { k: 'hole' }, cod: c, ...(pat ? { pat } : {}) }, k] as [Q, number]))
    }
    for (const [e, j] of expr(i, -Infinity, true)) {
      out.push([e, j])
      if (toks[j] === '->') out.push(...typ(j + 1).map(([c, k]) => [{ k: 'pi', names: null, hid: 0, dom: e, cod: c }, k] as [Q, number]))
    }
    return out
  })

  const seen = new Set<string>()
  const parses: Q[] = []
  for (const [q, j] of typ(0)) {
    if (j !== toks.length) continue
    const key = JSON.stringify(q, (k: string, v: unknown): unknown => (k === 'n' && v && typeof v === 'object' ? `${(v as Notation).name}${(v as Notation).level}` : v))
    if (seen.has(key)) continue
    seen.add(key)
    parses.push(q)
    if (parses.length >= MAX_PARSES) break
  }
  return parses
}

// trees to query signatures

const SORT = /^(Set|Type|Prop|SSet)[\dω]*$/

// variable names
const variableLike = (w: string, env: Env): boolean => /^\p{L}[\d']*$/u.test(w) && !env.concrete.has(w)

export interface Query {
  sig: Sig
  // constant occurrences
  consts: Set<string>[]
  // unresolved names
  unknown: string[]
  // declared variable types
  declared?: Map<string, Term>
  // variable bound by each argument
  binders?: (string | null)[]
}

const meets = (a: Set<string>, b?: Set<string>): boolean => Boolean(b) && [...a].some(x => b!.has(x))

export const toQuery = (q: Q, env: Env): Query => {
  const consts: Set<string>[] = []
  const unknown: string[] = []
  let holes = 0
  const top = new Set<string>()
  const hole = (): Term => ({ k: 'm', m: `h${holes++}`, a: [] })
  const constant = (ids: Set<string>, a: Term[]): Term => {
    // literal zero and suc
    if (a.length === 0 && meets(ids, env.nat?.zero)) return { k: 'n', v: '0' }
    if (a.length === 1 && meets(ids, env.nat?.suc) && a[0]!.k === 'n' && /^\d+$/.test(a[0]!.v)) return { k: 'n', v: String(BigInt(a[0]!.v) + 1n) }
    consts.push(ids)
    return { k: 'c', id: ids, a }
  }
  const plain = (w: string): Notation[] => (env.names.get(w) ?? []).filter(n => n.name === w)
  // pattern fields as projections
  const fields = new Map<string, { binder: string, path: Set<string>[] }>()
  const destructure = (pat: Q, binder: string, path: Set<string>[]) => {
    if (pat.k === 'paren') return destructure(pat.e, binder, path)
    if (pat.k === 'word' && !plain(pat.w).some(n => n.fields)) {
      fields.set(pat.w, { binder, path })
      return
    }
    const [n, args] = pat.k === 'op' ? [pat.n, pat.args] as const : pat.k === 'app' && pat.f.k === 'word' ? [plain(pat.f.w).find(x => x.fields), pat.args] as const : [undefined, []] as const
    if (!n?.fields) return
    args.forEach((a, i) => {
      const f = n.fields![i]
      if (a && f) destructure(a, binder, [...path, f])
    })
  }
  const named = (w: string): Set<string> | null => {
    const ns = plain(w)
    return ns.length > 0 ? new Set(ns.flatMap(n => [...n.ids])) : null
  }
  // λ body, hidden binders dropped
  const lams = (names: (string | null)[], local: string[], body: (l: string[]) => Term): Term =>
    names.reduceRight<(l: string[]) => Term>((b, n) => (n === null ? b : l => ({ k: 'l', b: b([...l, n]) })), body)(local)
  const conv = (q: Q, local: string[]): Term => {
    switch (q.k) {
      case 'paren': return conv(q.e, local)
      case 'hole': return hole()
      case 'section': return hole()
      case 'any': return { k: 'w' }
      case 'meta': return { k: 'm', m: `q:${q.name}`, a: [] }
      case 'lit': return { k: 'n', v: q.v }
      case 'word': {
        const at = local.lastIndexOf(q.w)
        if (at >= 0) return { k: 'b', i: local.length - 1 - at, a: [] }
        const field = fields.get(q.w)
        if (field) return field.path.reduce<Term>((t, f) => constant(f, [t]), conv({ k: 'word', w: field.binder }, local))
        if (top.has(q.w) || variableLike(q.w, env)) return { k: 'm', m: `q:${q.w}`, a: [] }
        if (SORT.test(q.w)) return { k: 's' }
        const ids = named(q.w)
        if (ids) return constant(ids, [])
        // variable-like names
        if (/^\p{Ll}s?['\d]*$/u.test(q.w) || (/^\p{Ll}[\p{L}\d']{0,2}$/u.test(q.w) && !env.elsewhere?.has(q.w))) return { k: 'm', m: `q:${q.w}`, a: [] }
        unknown.push(q.w)
        return constant(new Set(), [])
      }
      case 'op': {
        // sections as λ
        const sections = q.args.filter(a => a?.k === 'section').length
        if (sections > 0) {
          let k = 0
          const names = Array.from({ length: sections }, (_, i) => `§${i}`)
          const args = q.args.map(a => (a?.k === 'section' ? { k: 'word' as const, w: names[k++]! } : a))
          return lams(names, local, l => conv({ ...q, args }, l))
        }
        const els = elementsOf(q.n)
        const holeEls = els.filter((e): e is El & { k: 'hole' } => e.k === 'hole').sort((a, b) => a.n - b.n)
        const args = holeEls.filter(h => !h.hidden).map(h => {
          const a = q.args[h.n]
          if (!a) return hole()
          const bound = q.binds[h.n] ?? []
          return lams(bound.map(b => b ?? ''), local, l => conv(a, l))
        })
        return constant(q.n.ids, kept(q.n.keep, args))
      }
      case 'app': {
        const f = conv(q.f, local)
        const args = q.args.map(a => conv(a, local))
        if (f.k === 's') return f
        if (f.k === 'c') {
          const keep = q.f.k === 'word' ? plain(q.f.w)[0]?.keep : undefined
          return typeof f.id === 'string' ? { ...f, a: [...f.a, ...args] } : constant(f.id, kept(keep, [...f.a, ...args]))
        }
        if (f.k === 'm' || f.k === 'b') return { ...f, a: [...f.a, ...args] }
        // applied mixfix section
        return apply(f, args) ?? { k: 'w' }
      }
      case 'pi': {
        if (q.pat && q.names) destructure(q.pat, q.names[0]!, [])
        const d = conv(q.dom, local)
        const names = q.names ?? ['']
        let inner = local
        const ds = names.map((n, i) => {
          const dom = i === 0 ? d : conv(q.dom, inner)
          inner = [...inner, n]
          return dom
        })
        return ds.reduceRight<Term>((c, dom) => ({ k: 'p', d: dom, c }), conv(q.cod, inner))
      }
      case 'lam': return lams(q.names, local, l => conv(q.body, l))
    }
  }
  // outer telescope
  const args: Term[] = []
  const binders: (string | null)[] = []
  const declared = new Map<string, Term>()
  let t = q
  while (t.k === 'pi' || t.k === 'paren') {
    if (t.k === 'paren') {
      if (t.e.k !== 'pi') break
      t = t.e
      continue
    }
    const dom = t.dom
    const sortLike = (dom.k === 'word' && (SORT.test(dom.w) || dom.w === 'Level')) || (dom.k === 'app' && dom.f.k === 'word' && SORT.test(dom.f.w))
    if (t.names) for (const n of t.names) top.add(n)
    if (t.pat && t.names) destructure(t.pat, t.names[0]!, [])
    if (t.hid === 0 && !sortLike) {
      for (let i = 0; i < (t.names?.length ?? 1); i++) {
        args.push(conv(dom, []))
        binders.push(t.names?.[i] ? `q:${t.names[i]}` : null)
      }
    }
    if (t.names && dom.k !== 'hole' && !t.pat) for (const n of t.names) declared.set(`q:${n}`, conv(dom, []))
    t = t.cod
  }
  return { sig: { args, res: conv(t, []) }, consts, unknown, declared, binders }
}
