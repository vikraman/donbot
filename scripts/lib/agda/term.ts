import { hash } from './fold.ts'

// matcher terms
export type Term =
  // constant, id set if ambiguous
  | { k: 'c', id: string | Set<string>, a: Term[] }
  // pattern variable
  | { k: 'm', m: string, a: Term[] }
  // local binder, de bruijn
  | { k: 'b', i: number, a: Term[] }
  | { k: 'p', d: Term, c: Term }
  | { k: 'l', b: Term }
  | { k: 's' }
  | { k: 'n', v: string }
  // anything
  | { k: 'w' }

// explicit arguments and conclusion
export interface Sig {
  args: Term[]
  res: Term
  // independent premises
  premises?: number
  marks?: boolean[]
  // telescope types and argument binders
  types?: Term[]
  argVars?: (number | null)[]
}

// name table entry
export interface NameInfo {
  id: string
  sort?: boolean
  np?: number
  lvl?: boolean
  // alias argument passing
  keep?: [number[], number]
  // inlined heads
  inline?: 'id' | 'idfun' | 'comp' | 'lit' | 'neg' | 'zero' | 'suc'
}

const INLINE: Record<string, NameInfo['inline']> = { id: 'id', 'id′': 'id', idfun: 'idfun', '_∘_': 'comp', '_∘′_': 'comp' }

export const inlineOf = (concrete: string): NameInfo['inline'] => INLINE[concrete]

// alias args for its target
export const kept = <T>(keep: [number[], number] | undefined, args: T[]): T[] =>
  !keep || args.length < keep[1] ? args : [...keep[0].map(i => args[i]!), ...args.slice(keep[1])]

const applyTo = (t: Stored, more: Stored[]): Stored =>
  more.length === 0 ? t : ['c', 'v', 'b'].includes(t[0] as string) ? [...t, ...more] : ['_']

const SORTS = new Set(['Set', 'Prop', 'Setω', 'Propω', 'SSet', 'SSetω', 'LevelUniv'].map(s => `Agda.Primitive.${s}`).concat(['Agda.Primitive.Cubical.IUniv', 'Agda.Builtin.Size.SizeUniv']))

export const isSortName = (q: string): boolean => SORTS.has(q)

export const LEVEL = hash('Agda.Primitive.Level')

// raw indexer terms
type Raw = unknown[]

const arr = (x: unknown): Raw => (Array.isArray(x) ? x : ['?'])

// stored form
export type Stored = unknown[]

// telescope types and binders
export interface Typing {
  types: Stored[]
  argVars: (number | null)[]
}

export const normalise = (raw: unknown, names: (i: number) => NameInfo | undefined, typing?: Typing): Stored => {
  const top = new Map<number, number>()
  const levels = new Set<number>()
  const erased = new Set<number>()
  const info = (t: Raw): NameInfo | undefined => (t[0] === 'c' && typeof t[1] === 'number' ? names(t[1]) : undefined)
  const levelType = (t: Raw): boolean => info(t)?.id === LEVEL
  const levelExpr = (t: Raw): boolean => {
    if (t[0] === 'v') return levels.has(t[1] as number)
    if (t[0] === 'a') return levelExpr(arr(t[1]))
    return info(t)?.lvl === true
  }
  const conv = (t: Raw, env: number[]): Stored => {
    switch (t[0]) {
      case 'v': {
        if (erased.has(t[1] as number)) return ['_']
        const at = env.lastIndexOf(t[1] as number)
        if (at >= 0) return ['b', env.length - 1 - at]
        const k = top.get(t[1] as number)
        return k === undefined ? ['_'] : ['v', k]
      }
      case 'c': return app(t, [], env)
      case 'a': return app(arr(t[1]), t.slice(2).map(arr), env)
      case 'p': {
        const b = typeof t[2] === 'number' ? t[2] : -1
        if (levelType(arr(t[3]))) levels.add(b)
        return ['p', conv(arr(t[3]), env), conv(arr(t[4]), [...env, b])]
      }
      // drop λ {a} wrappers
      case 'l':
        if (t[1] !== 0) {
          erased.add(t[2] as number)
          return conv(arr(t[3]), env)
        }
        return ['l', conv(arr(t[3]), [...env, t[2] as number])]
      case 'n': return ['n', String(t[1])]
      default: return ['_']
    }
  }
  // explicit arguments only
  const app = (head: Raw, rawArgs: Raw[], env: number[]): Stored => {
    if (head[0] === 'a') return app(arr(head[1]), [...head.slice(2).map(arr), ...rawArgs], env)
    let vis = rawArgs.filter(a => a[0] === 0).map(a => arr(a[1]))
    if (head[0] === 'c') {
      const n = info(head)
      if (!n) return ['_']
      if (n.sort) return ['s']
      vis = vis.slice(n.np ?? 0)
      const args = kept(n.keep, vis.filter(a => !levelExpr(a)).map(a => conv(a, env)))
      if (n.inline === 'id' && args.length >= 1) return applyTo(args[0]!, args.slice(1))
      if (n.inline === 'idfun' && args.length >= 2) return applyTo(args[1]!, args.slice(2))
      if (n.inline === 'comp' && args.length >= 3) return applyTo(args[0]!, [applyTo(args[1]!, [args[2]!]), ...args.slice(3)])
      // numerals as literals
      const lit = args.findLast(a => a[0] === 'n')
      if ((n.inline === 'lit' || n.inline === 'neg') && lit) return ['n', n.inline === 'neg' ? `-${String(lit[1])}` : lit[1]]
      if (n.inline === 'zero' && args.length === 0) return ['n', '0']
      if (n.inline === 'suc' && args.length === 1 && lit && /^\d+$/.test(String(lit[1]))) return ['n', String(BigInt(String(lit[1])) + 1n)]
      return ['c', n.id, ...args]
    }
    if (head[0] === 'v') {
      const h = conv(head, env)
      if (h[0] === '_') return h
      return [...h, ...vis.filter(a => !levelExpr(a)).map(a => conv(a, env))]
    }
    return ['_']
  }
  let t = arr(raw)
  const args: Stored[] = []
  const vars: (number | null)[] = []
  let k = 0
  while (t[0] === 'p') {
    const dom = arr(t[3])
    const level = levelType(dom)
    const named = typeof t[2] === 'number'
    if (named) {
      // drop level binders
      typing?.types.push(level ? ['_'] : conv(dom, []))
      top.set(t[2] as number, k++)
      if (level) levels.add(t[2] as number)
    }
    // hidden binders as variables
    if (t[1] === 0 && !level) {
      args.push(conv(dom, []))
      vars.push(named ? k - 1 : null)
    }
    t = arr(t[4])
  }
  const res = conv(t, [])
  if (typing) typing.argVars = vars
  // independent premises
  const mentions = (x: unknown, v: number): boolean =>
    Array.isArray(x) && ((x[0] === 'v' && x[1] === v) || x.some(y => mentions(y, v)))
  const marked = args.map((a, i) => {
    const v = vars[i]
    const used = v != null && (mentions(res, v) || args.slice(i + 1).some(b => mentions(b, v)))
    return used ? a : ['!', a]
  })
  return [res, ...marked]
}

// stored form to terms
export const decode = (stored: Stored, prefix: string, typing?: Typing): Sig => {
  const go = (t: Raw): Term => {
    switch (t[0]) {
      case 'c': return { k: 'c', id: String(t[1]), a: t.slice(2).map(x => go(arr(x))) }
      case 'v': return { k: 'm', m: `${prefix}${String(t[1])}`, a: t.slice(2).map(x => go(arr(x))) }
      case 'b': return { k: 'b', i: t[1] as number, a: t.slice(2).map(x => go(arr(x))) }
      case 'p': return { k: 'p', d: go(arr(t[1])), c: go(arr(t[2])) }
      case 'l': return { k: 'l', b: go(arr(t[1])) }
      case 's': return { k: 's' }
      case 'n': return { k: 'n', v: String(t[1]) }
      default: return { k: 'w' }
    }
  }
  const [res, ...args] = stored.map(arr)
  const marks = args.map(a => a[0] === '!')
  const sig: Sig = { args: args.map(a => go(a[0] === '!' ? arr(a[1]) : a)), res: res ? go(res) : { k: 'w' }, premises: marks.filter(Boolean).length, marks }
  if (typing) {
    sig.types = typing.types.map(t => go(arr(t)))
    sig.argVars = typing.argVars
  }
  return sig
}

const visit = (t: Term, f: (t: Term) => void) => {
  f(t)
  switch (t.k) {
    case 'c': case 'm': case 'b': t.a.forEach(x => visit(x, f)); break
    case 'p': visit(t.d, f); visit(t.c, f); break
    case 'l': visit(t.b, f); break
  }
}

export const sigTerms = (s: Sig): Term[] => [s.res, ...s.args]

// constant ids mentioned
export const consts = (s: Sig): Set<string> => {
  const out = new Set<string>()
  for (const t of sigTerms(s)) visit(t, x => {
    if (x.k === 'c') for (const id of typeof x.id === 'string' ? [x.id] : x.id) out.add(id)
  })
  return out
}

// stable key, ambiguous ids sorted
export const termKey = (t: Term): string => JSON.stringify(t, (_: string, v: unknown): unknown => (v instanceof Set ? [...(v as Set<string>)].sort() : v))

export const size = (s: Sig): number => {
  let n = 0
  for (const t of sigTerms(s)) visit(t, () => n++)
  return n
}

// over cap, counted lazily
export const larger = (s: Sig, cap: number): boolean => {
  let n = 0
  const go = (t: Term): boolean => {
    if (++n > cap) return true
    switch (t.k) {
      case 'c': case 'm': case 'b': return t.a.some(go)
      case 'p': return go(t.d) || go(t.c)
      case 'l': return go(t.b)
      default: return false
    }
  }
  return sigTerms(s).some(go)
}

export const headId = (t: Term): string | undefined => (t.k === 'c' && typeof t.id === 'string' ? t.id : undefined)

// constant-headed subterms
export const subterms = (s: Sig): Term[] => {
  const out: Term[] = []
  for (const t of sigTerms(s)) visit(t, x => {
    if (x.k === 'c') out.push(x)
  })
  return out
}

// reduction budget
const MAX_BETA = 500
const MAX_NODES = 50_000
let beta = 0
let nodes = 0
let active = 0

export class TooBig extends Error {}

const budgeted = <T>(f: () => T): T => {
  if (active === 0) {
    beta = MAX_BETA
    nodes = MAX_NODES
  }
  active++
  try {
    return f()
  } finally {
    active--
  }
}

// apply, β-reducing
export const apply = (t: Term, args: Term[]): Term | null => budgeted(() => applyIn(t, args))

const applyIn = (t: Term, args: Term[]): Term | null => {
  if (args.length === 0) return t
  switch (t.k) {
    case 'c': case 'm': case 'b': return { ...t, a: [...t.a, ...args] }
    case 'l':
      if (--beta < 0) throw new TooBig('too many reductions')
      return applyIn(instantiateIn(t.b, args[0]!, 0), args.slice(1))
    case 'w': return t
    default: return null
  }
}

// substitute b0
export const instantiate = (t: Term, v: Term, depth = 0): Term => budgeted(() => instantiateIn(t, v, depth))

const instantiateIn = (t: Term, v: Term, depth: number): Term => {
  if (--nodes < 0) throw new TooBig('term too large')
  switch (t.k) {
    case 'b': {
      const a = t.a.map(x => instantiateIn(x, v, depth))
      if (t.i === depth) return applyIn(v, a) ?? { k: 'w' }
      return { ...t, i: t.i > depth ? t.i - 1 : t.i, a }
    }
    case 'c': case 'm': return { ...t, a: t.a.map(x => instantiateIn(x, v, depth)) }
    case 'p': return { k: 'p', d: instantiateIn(t.d, v, depth), c: instantiateIn(t.c, v, depth + 1) }
    case 'l': return { k: 'l', b: instantiateIn(t.b, v, depth + 1) }
    default: return t
  }
}

// abstract bound variables
export const abstract = (t: Term, vars: number[]): Term | null => {
  const go = (u: Term, depth: number): Term | null => {
    const args = (xs: Term[]) => {
      const out: Term[] = []
      for (const x of xs) {
        const y = go(x, depth)
        if (!y) return null
        out.push(y)
      }
      return out
    }
    switch (u.k) {
      case 'b': {
        const a = args(u.a)
        if (!a) return null
        if (u.i < depth) return { ...u, a }
        const j = vars.indexOf(u.i - depth)
        return j < 0 ? null : { k: 'b', i: depth + vars.length - 1 - j, a }
      }
      case 'c': case 'm': {
        const a = args(u.a)
        return a && { ...u, a }
      }
      case 'p': {
        const d = go(u.d, depth)
        const c = go(u.c, depth + 1)
        return d && c && { k: 'p', d, c }
      }
      case 'l': {
        const b = go(u.b, depth + 1)
        return b && { k: 'l', b }
      }
      default: return u
    }
  }
  const body = go(t, 0)
  return body && vars.reduce<Term>(b => ({ k: 'l', b }), body)
}

// back to stored form
export const encodeTyping = (s: Sig): Typing => ({ types: (s.types ?? []).map(encodeTerm), argVars: s.argVars ?? [] })

export const encodeTerm = (t: Term): Stored => {
  switch (t.k) {
    case 'c': return ['c', typeof t.id === 'string' ? t.id : [...t.id][0], ...t.a.map(encodeTerm)]
    case 'm': return ['v', Number(t.m.slice(1)), ...t.a.map(encodeTerm)]
    case 'b': return ['b', t.i, ...t.a.map(encodeTerm)]
    case 'p': return ['p', encodeTerm(t.d), encodeTerm(t.c)]
    case 'l': return ['l', encodeTerm(t.b)]
    case 's': return ['s']
    case 'n': return ['n', t.v]
    case 'w': return ['_']
  }
}

export const encode = (s: Sig): Stored => {
  const go = (t: Term): Stored => {
    switch (t.k) {
      case 'c': return ['c', typeof t.id === 'string' ? t.id : [...t.id][0], ...t.a.map(go)]
      case 'm': return ['v', Number(t.m.slice(1)), ...t.a.map(go)]
      case 'b': return ['b', t.i, ...t.a.map(go)]
      case 'p': return ['p', go(t.d), go(t.c)]
      case 'l': return ['l', go(t.b)]
      case 's': return ['s']
      case 'n': return ['n', t.v]
      case 'w': return ['_']
    }
  }
  return [go(s.res), ...s.args.map((a, i) => (s.marks?.[i] ? ['!', go(a)] : go(a)))]
}
