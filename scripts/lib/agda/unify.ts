import { abstract, apply, type Term } from './term.ts'

// first-order unification

export type Subst = Map<string, Term>

// builtin suc per library
let succ = new Set<string>()
export const setSuc = (ids: Set<string>): void => {
  succ = ids
}

const isSuc = (id: string | Set<string>): boolean => (typeof id === 'string' ? succ.has(id) : [...id].some(x => succ.has(x)))

export interface Budget {
  steps: number
  // types: reducible constants don't clash
  open?: (id: string | Set<string>) => boolean
  // types: one-step alias unfolding
  unfold?: (t: Term & { k: 'c' }) => Term | null
}

const sameId = (a: string | Set<string>, b: string | Set<string>): boolean =>
  typeof a === 'string'
    ? typeof b === 'string' ? a === b : b.has(a)
    : typeof b === 'string' ? a.has(b) : [...a].some(x => b.has(x))

const withArgs = apply

// follow bound variables
const walk = (t: Term, s: Subst): Term | null => {
  while (t.k === 'm') {
    const v = s.get(t.m)
    if (!v) return t
    const next = withArgs(v, t.a)
    if (!next) return null
    t = next
  }
  return t
}

// escapes its binder
const escapes = (t: Term, depth = 0): boolean => {
  switch (t.k) {
    case 'b': return t.i >= depth || t.a.some(x => escapes(x, depth))
    case 'c': case 'm': return t.a.some(x => escapes(x, depth))
    case 'p': return escapes(t.d, depth) || escapes(t.c, depth + 1)
    case 'l': return escapes(t.b, depth + 1)
    default: return false
  }
}

const occurs = (m: string, t: Term, s: Subst): boolean => {
  const w = walk(t, s)
  if (!w) return false
  switch (w.k) {
    case 'm': return w.m === m || w.a.some(x => occurs(m, x, s))
    case 'c': case 'b': return w.a.some(x => occurs(m, x, s))
    case 'p': return occurs(m, w.d, s) || occurs(m, w.c, s)
    case 'l': return occurs(m, w.b, s)
    default: return false
  }
}

const bind = (m: string, t: Term, s: Subst): boolean => {
  if (t.k === 'm' && t.m === m && t.a.length === 0) return true
  if (escapes(t) || occurs(m, t, s)) return false
  s.set(m, t)
  return true
}

// m a₁…aₖ against t
// postponable passes in types
const solve = (m: Term & { k: 'm' }, t: Term, s: Subst, budget: Budget): boolean => {
  const k = m.a.length
  // occurs check
  if (k === 0) return bind(m.m, t, s) || (Boolean(budget.open) && !occurs(m.m, t, s))
  if (t.k === 'm' && t.a.length < k) return solve(t, m, s, budget)
  const before = new Map(s)
  if (firstOrder(m, t, s, budget)) return true
  s.clear()
  for (const [x, v] of before) s.set(x, v)
  return pattern(m, t, s) || Boolean(budget.open)
}

// flex-rigid by spine
const firstOrder = (m: Term & { k: 'm' }, t: Term, s: Subst, budget: Budget): boolean => {
  const k = m.a.length
  if (t.k !== 'c' && t.k !== 'm' && t.k !== 'b') return false
  if (t.a.length < k) return false
  const n = t.a.length - k
  if (!bind(m.m, { ...t, a: t.a.slice(0, n) }, s)) return false
  return m.a.every((x, i) => unify(x, t.a[n + i]!, s, budget))
}

// miller patterns
const pattern = (m: Term & { k: 'm' }, t: Term, s: Subst): boolean => {
  const vars: number[] = []
  for (const x of m.a) {
    const v = walk(x, s)
    if (!v || v.k !== 'b' || v.a.length > 0 || vars.includes(v.i)) return false
    vars.push(v.i)
  }
  const body = abstract(t, vars)
  return body !== null && bind(m.m, body, s)
}

// mutates s
export const unify = (x: Term, y: Term, s: Subst, budget: Budget): boolean => {
  if (--budget.steps < 0) return false
  const a = walk(x, s)
  const b = walk(y, s)
  if (!a || !b) return false
  if (a.k === 'w' || b.k === 'w') return true
  if (a.k === 'm' && b.k === 'm' && a.m === b.m && a.a.length === b.a.length) return a.a.every((t, i) => unify(t, b.a[i]!, s, budget))
  if (a.k === 'm') return solve(a, b, s, budget)
  if (b.k === 'm') return solve(b, a, s, budget)
  // literal against suc
  const lit = a.k === 'n' ? a : b.k === 'n' ? b : null
  const other = lit === a ? b : a
  if (lit && other.k === 'c' && other.a.length === 1 && isSuc(other.id) && /^[1-9]\d*$/.test(lit.v)) {
    return unify({ k: 'n', v: String(BigInt(lit.v) - 1n) }, other.a[0]!, s, budget)
  }
  if (budget.unfold && a.k === 'c' && b.k === 'c' && !sameId(a.id, b.id)) {
    const ua = budget.unfold(a)
    if (ua) return unify(ua, b, s, budget)
    const ub = budget.unfold(b)
    if (ub) return unify(a, ub, s, budget)
  }
  // open heads postpone
  if (budget.open && ((a.k === 'c' && budget.open(a.id)) || (b.k === 'c' && budget.open(b.id)))) {
    if (a.k !== 'c' || b.k !== 'c' || a.a.length !== b.a.length || !sameId(a.id, b.id)) return true
    const before = new Map(s)
    if (a.a.every((t, i) => unify(t, b.a[i]!, s, budget))) return true
    s.clear()
    for (const [x, v] of before) s.set(x, v)
    return true
  }
  switch (a.k) {
    case 'c': return b.k === 'c' && a.a.length === b.a.length && sameId(a.id, b.id) && a.a.every((t, i) => unify(t, b.a[i]!, s, budget))
    case 'b': return b.k === 'b' && a.i === b.i && a.a.length === b.a.length && a.a.every((t, i) => unify(t, b.a[i]!, s, budget))
    case 'p': return b.k === 'p' && unify(a.d, b.d, s, budget) && unify(a.c, b.c, s, budget)
    case 'l': return b.k === 'l' && unify(a.b, b.b, s, budget)
    case 's': return b.k === 's'
    case 'n': return b.k === 'n' && a.v === b.v
  }
}

// bound variables
export const specialised = (s: Subst, counts: (m: string) => boolean, compound = 1): number => {
  let n = 0
  for (const [m] of s) {
    if (!counts(m)) continue
    const v = walk({ k: 'm', m, a: [] }, s)
    if (!v || v.k === 'w') continue
    // rigid binders are variables
    if (v.k === 'c' && typeof v.id === 'string' && v.id.startsWith('#') && v.a.length === 0) continue
    if (v.k !== 'm') n += v.k === 'p' || v.k === 'l' || ('a' in v && v.a.length > 0) ? compound : 1
    else if (v.m !== m && counts(v.m)) n++
  }
  return n
}

// distinct query variables merged
export const merged = (s: Subst): boolean => {
  const seen = new Set<string>()
  for (const [m] of s) {
    if (!m.startsWith('q:')) continue
    const v = walk({ k: 'm', m, a: [] }, s)
    if (!v) continue
    const name = v.k === 'm' && v.a.length === 0 ? v.m : v.k === 'c' && v.a.length === 0 && typeof v.id === 'string' && v.id.startsWith('#') ? v.id : null
    if (!name) continue
    if (name.startsWith('q:')) return true
    if (seen.has(name)) return true
    seen.add(name)
  }
  return false
}

// current binding
export const resolve = (m: string, s: Subst): Term | null => walk({ k: 'm', m, a: [] }, s)
