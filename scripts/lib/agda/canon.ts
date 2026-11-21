import { apply, type Sig, type Term } from './term.ts'

// aliases of primitives in one form

export interface Template {
  // the alias
  id: string
  // explicit params
  vis: boolean[]
  // body, params as metas
  body: Term
  // use count
  refs?: number
}

const MAX_DEPTH = 4

const ids = (id: string | Set<string>): string[] => (typeof id === 'string' ? [id] : [...id])

const has = (id: string | Set<string>, x: string): boolean => (typeof id === 'string' ? id === x : id.has(x))

// free binders from cutoff up moved by delta
export const shift = (t: Term, delta: number, cutoff = 0): Term => {
  if (delta === 0) return t
  switch (t.k) {
    case 'b': return { ...t, i: t.i >= cutoff ? t.i + delta : t.i, a: t.a.map(x => shift(x, delta, cutoff)) }
    case 'c': case 'm': return { ...t, a: t.a.map(x => shift(x, delta, cutoff)) }
    case 'p': return { k: 'p', d: shift(t.d, delta, cutoff), c: shift(t.c, delta, cutoff + 1) }
    case 'l': return { k: 'l', b: shift(t.b, delta, cutoff + 1) }
    default: return t
  }
}

const size = (t: Term): number => {
  switch (t.k) {
    case 'c': case 'm': case 'b': return 1 + t.a.reduce((n, x) => n + size(x), 0)
    case 'p': return 1 + size(t.d) + size(t.c)
    case 'l': return 1 + size(t.b)
    default: return 1
  }
}

const params = (tpl: Template) => tpl.vis.map((v, i) => [v, i] as const).filter(([v]) => v).map(([, i]) => i)

// body with params filled
const fill = (t: Term, values: Term[], depth = 0): Term => {
  switch (t.k) {
    case 'm': {
      const n = Number(t.m.slice(2))
      const a = t.a.map(x => fill(x, values, depth))
      return apply(shift(values[n] ?? { k: 'w' }, depth), a) ?? { k: 'w' }
    }
    case 'c': case 'b': return { ...t, a: t.a.map(x => fill(x, values, depth)) }
    case 'p': return { k: 'p', d: fill(t.d, values, depth), c: fill(t.c, values, depth + 1) }
    case 'l': return { k: 'l', b: fill(t.b, values, depth + 1) }
    default: return t
  }
}

const eq = (a: Term, b: Term): boolean => {
  if (a.k === 'w' || b.k === 'w') return true
  switch (a.k) {
    case 'c': return b.k === 'c' && ids(a.id).some(x => has(b.id, x)) && a.a.length === b.a.length && a.a.every((x, i) => eq(x, b.a[i]!))
    case 'm': return b.k === 'm' && a.m === b.m && a.a.length === b.a.length && a.a.every((x, i) => eq(x, b.a[i]!))
    case 'b': return b.k === 'b' && a.i === b.i && a.a.length === b.a.length && a.a.every((x, i) => eq(x, b.a[i]!))
    case 'p': return b.k === 'p' && eq(a.d, b.d) && eq(a.c, b.c)
    case 'l': return b.k === 'l' && eq(a.b, b.b)
    case 's': return b.k === 's'
    case 'n': return b.k === 'n' && a.v === b.v
  }
}

// t abstracted over vars
const capture = (t: Term, depth: number, vars: number[]): Term | null => {
  const k = vars.length
  const go = (u: Term, e: number): Term | null => {
    const args = (xs: Term[]): Term[] | null => {
      const out: Term[] = []
      for (const x of xs) {
        const y = go(x, e)
        if (!y) return null
        out.push(y)
      }
      return out
    }
    switch (u.k) {
      case 'b': {
        const a = args(u.a)
        if (!a) return null
        if (u.i < e) return { ...u, a }
        const j = u.i - e
        if (j < depth) {
          const q = vars.indexOf(j)
          return q < 0 ? null : { k: 'b', i: e + k - 1 - q, a }
        }
        return { k: 'b', i: e + k + j - depth, a }
      }
      case 'c': case 'm': {
        const a = args(u.a)
        return a && { ...u, a }
      }
      case 'p': {
        const d = go(u.d, e)
        const c = go(u.c, e + 1)
        return d && c && { k: 'p', d, c }
      }
      case 'l': {
        const b = go(u.b, e + 1)
        return b && { k: 'l', b }
      }
      default: return u
    }
  }
  const body = go(t, 0)
  return body && vars.reduce<Term>(b => ({ k: 'l', b }), body)
}

// t as template instance
const match = (pat: Term, t: Term, values: Map<number, Term>, depth = 0): boolean => {
  if (pat.k === 'm') {
    const vars: number[] = []
    for (const x of pat.a) {
      if (x.k !== 'b' || x.a.length > 0 || x.i >= depth || vars.includes(x.i)) return false
      vars.push(x.i)
    }
    const v = capture(t, depth, vars)
    if (!v) return false
    const n = Number(pat.m.slice(2))
    const prev = values.get(n)
    if (prev) return eq(prev, v)
    values.set(n, v)
    return true
  }
  if (t.k === 'w') return true
  switch (pat.k) {
    case 'c': return t.k === 'c' && ids(pat.id).some(x => has(t.id, x)) && pat.a.length === t.a.length && pat.a.every((x, i) => match(x, t.a[i]!, values, depth))
    case 'b': return t.k === 'b' && pat.i === t.i && pat.a.length === t.a.length && pat.a.every((x, i) => match(x, t.a[i]!, values, depth))
    case 'p': return t.k === 'p' && match(pat.d, t.d, values, depth) && match(pat.c, t.c, values, depth + 1)
    case 'l': return t.k === 'l' && match(pat.b, t.b, values, depth + 1)
    case 's': return t.k === 's'
    case 'n': return t.k === 'n' && pat.v === t.v
    default: return true
  }
}

const hasLambda = (t: Term): boolean => {
  switch (t.k) {
    case 'l': return true
    case 'c': case 'm': case 'b': return t.a.some(hasLambda)
    case 'p': return hasLambda(t.d) || hasLambda(t.c)
    default: return false
  }
}

const mentions = (t: Term, i: number): boolean => {
  switch (t.k) {
    case 'b': return t.i === i || t.a.some(x => mentions(x, i))
    case 'c': case 'm': return t.a.some(x => mentions(x, i))
    case 'p': return mentions(t.d, i) || mentions(t.c, i + 1)
    case 'l': return mentions(t.b, i + 1)
    default: return false
  }
}

// eta-contract λ i → p i
export const eta = (t: Term): Term => {
  switch (t.k) {
    case 'c': case 'm': case 'b': return { ...t, a: t.a.map(eta) }
    case 'p': return { k: 'p', d: eta(t.d), c: eta(t.c) }
    case 'l': {
      const b = eta(t.b)
      if ((b.k === 'c' || b.k === 'm' || b.k === 'b') && b.a.length > 0) {
        const last = b.a[b.a.length - 1]!
        const head = { ...b, a: b.a.slice(0, -1) }
        if (last.k === 'b' && last.i === 0 && last.a.length === 0 && !(head.k === 'b' && head.i === 0) && !mentions(head, 0)) return shift(head, -1)
      }
      return { k: 'l', b }
    }
    default: return t
  }
}

// unfold one alias
export const unfolder = (all: Template[]) => {
  const byAlias = new Map(all.filter(t => hasLambda(t.body)).map(t => [t.id, t]))
  return (t: Term & { k: 'c' }): Term | null => {
    const tpl = ids(t.id).map(x => byAlias.get(x)).find(Boolean)
    if (!tpl) return null
    const ps = params(tpl)
    if (t.a.length < ps.length) return null
    const values: Term[] = tpl.vis.map(() => ({ k: 'w' }))
    ps.forEach((p, i) => (values[p] = t.a[i]!))
    return apply(fill(tpl.body, values), t.a.slice(ps.length))
  }
}

export const canonicaliser = (all: Template[]) => {
  // only binder-abbreviating aliases
  const templates = all.filter(t => hasLambda(t.body))
  // one id per body
  const used = new Map(templates.map(t => [t.id, t.refs ?? 0]))
  const classes = new Map<string, string>()
  for (const t of templates) {
    const key = JSON.stringify([t.vis, t.body])
    const prev = classes.get(key)
    if (!prev || used.get(t.id)! > used.get(prev)! || (used.get(t.id) === used.get(prev) && t.id < prev)) classes.set(key, t.id)
  }
  const representative = new Map(templates.map(t => [t.id, classes.get(JSON.stringify([t.vis, t.body]))!]))
  const byAlias = new Map(templates.map(t => [t.id, t]))
  // best representative first
  const folds = [...new Map(templates.filter(t => t.body.k === 'c').map(t => [representative.get(t.id), { ...t, id: representative.get(t.id)! }])).values()]
    .sort((a, b) => params(a).length - params(b).length || size(b.body) - size(a.body) || (used.get(b.id) ?? 0) - (used.get(a.id) ?? 0))

  const children = (t: Term, f: (t: Term) => Term): Term => {
    switch (t.k) {
      case 'c': case 'm': case 'b': return { ...t, a: t.a.map(f) }
      case 'p': return { k: 'p', d: f(t.d), c: f(t.c) }
      case 'l': return { k: 'l', b: f(t.b) }
      default: return t
    }
  }

  // ambiguous constants keep alternatives
  const widen = (u: Term & { k: 'c' }): Term => {
    if (typeof u.id === 'string' || u.id.size < 2) return u
    const extra = [...u.id].map(x => representative.get(x)).filter((x): x is string => Boolean(x) && !(u.id as Set<string>).has(x!))
    return extra.length === 0 ? u : { ...u, id: new Set([...u.id, ...extra]) }
  }

  // aliases unfolded
  const expand = (t: Term, depth = 0): Term => {
    const u = children(t, x => expand(x, depth))
    if (u.k !== 'c' || depth >= MAX_DEPTH) return u
    const candidates = ids(u.id).filter(x => byAlias.has(x))
    if (candidates.length !== 1) return ids(u.id).length > 1 ? widen(u) : u
    // ambiguous names keep alternatives if the abbreviation agrees
    if (ids(u.id).length > 1) {
      const alone = fold(expand({ ...u, id: candidates[0]! }, depth))
      const same = alone.k === 'c' && alone.a.length === u.a.length && alone.a.every((x, i) => eq(x, u.a[i]!))
      return same ? { ...u, id: new Set([...ids(u.id), ...ids((alone).id)]) } : alone
    }
    const tpl = byAlias.get(candidates[0]!)!
    const ps = params(tpl)
    if (u.a.length < ps.length) return u
    const values: Term[] = tpl.vis.map(() => ({ k: 'w' }))
    ps.forEach((p, i) => (values[p] = u.a[i]!))
    const body = apply(fill(tpl.body, values), u.a.slice(ps.length))
    return body ? expand(body, depth + 1) : u
  }

  // fold primitives into aliases
  const fold = (t: Term): Term => {
    const u = children(t, fold)
    if (u.k !== 'c' || ids(u.id).length > 1) return u
    for (const tpl of folds) {
      const body = tpl.body as Term & { k: 'c' }
      if (u.a.length < body.a.length || !ids(body.id).some(x => has(u.id, x))) continue
      const values = new Map<number, Term>()
      if (!match(body, { ...u, a: u.a.slice(0, body.a.length) }, values)) continue
      const ps = params(tpl)
      if (!ps.every(p => values.has(p))) continue
      return { k: 'c', id: tpl.id, a: [...ps.map(p => values.get(p)!), ...u.a.slice(body.a.length)] }
    }
    return u
  }

  const term = (t: Term): Term => eta(templates.length === 0 ? t : fold(expand(t)))
  return (s: Sig): Sig => ({ ...s, args: s.args.map(term), res: term(s.res), ...(s.types ? { types: s.types.map(term) } : {}) })
}
