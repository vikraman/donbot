import { cached, namesById, scope, search, tags } from './store.ts'
import { zonk, type Hit } from './search.ts'
import { termKey, type Term } from './term.ts'
import { resolve as resolveMeta } from './unify.ts'

// why a hit matched

// display names
const nameCache = () => cached('names', () => new Map<string, string | null>())
const CHUNK = 100

// display names by id
const loadNames = async (want: Iterable<string>): Promise<void> => {
  const names = nameCache()
  const missing = [...new Set(want)].filter(id => !id.startsWith('#') && !names.has(id))
  for (let i = 0; i < missing.length; i += CHUNK) {
    const chunk = missing.slice(i, i + CHUNK)
    const limit = chunk.length * 8
    const { docs } = await search(tags('self', chunk), { limit, fields: ['self', 'n'] })
    for (const d of docs) if (d.self && d.n && !names.get(d.self)) names.set(d.self, d.n)
    // full page, maybe truncated
    if (docs.length < limit) for (const id of chunk) if (!names.has(id)) names.set(id, null)
  }
}

const idsIn = (t: Term, out: Set<string>): Set<string> => {
  switch (t.k) {
    case 'c': for (const id of typeof t.id === 'string' ? [t.id] : t.id) out.add(id); t.a.forEach(x => idsIn(x, out)); break
    case 'm': case 'b': t.a.forEach(x => idsIn(x, out)); break
    case 'p': idsIn(t.d, out); idsIn(t.c, out); break
    case 'l': idsIn(t.b, out); break
  }
  return out
}

// binder names per telescope variable
export const binderNames = (type: string): string[] => {
  const out: string[] = []
  let depth = 0
  for (let i = 0; i < type.length; i++) {
    const ch = type[i]!
    if ('({⦃'.includes(ch)) {
      if (depth === 0) {
        const m = /^[({⦃]\s*([^{}()⦃⦄:]+?)\s*:/.exec(type.slice(i))
        // {I = I₁ : …} names I₁
        if (m) out.push(...m[1]!.replace(/\S+\s*=\s*(\S+)/g, '$1').split(/\s+/).filter(Boolean))
      }
      depth++
    } else if (')}⦄'.includes(ch)) depth--
  }
  return out
}

const BOUND = ['x', 'y', 'z', 'w', 'u', 'v']
// match markers
const OPEN = '\uE000'
const CLOSE = '\uE001'

const holes = (name: string): number => (name === '_' || !name.includes('_') ? 0 : name.split('_').length - 1)

export const explain = async (h: Hit, query = ''): Promise<string[]> => {
  const m = h.match
  if (!m) return []
  const s = m.subst
  const z = (t: Term) => zonk(t, s)
  const types = m.cand.types ?? []
  const own = binderNames(h.entry.type)
  const binder = (k: number): string => (own.length === types.length ? own[k]! : `#${k}`)
  // query and candidate variable names
  const queryVars = new Set<string>()
  const holeMetas = new Set<string>()
  const visit = (t: Term) => {
    if (t.k === 'm' && t.m.startsWith('q:')) queryVars.add(t.m)
    if (t.k === 'm' && /^h\d+$/.test(t.m)) holeMetas.add(t.m)
    if (t.k === 'c' || t.k === 'm' || t.k === 'b') t.a.forEach(visit)
    if (t.k === 'p') [t.d, t.c].forEach(visit)
    if (t.k === 'l') visit(t.b)
  }
  ;[m.query.res, ...m.query.args].forEach(visit)
  // reserved names
  const taken = new Set([...queryVars].map(q => q.slice(2)).concat(own))
  const fresh = (env: string[]): string => {
    for (let n = 0; ; n++) {
      const x = `${BOUND[n % BOUND.length]}${n < BOUND.length ? '' : Math.floor(n / BOUND.length)}`
      if (!taken.has(x) && !env.includes(x)) return x
    }
  }
  const yours = new Map<string, string>()
  // query variable of a candidate variable
  const sameVar = (r: Term | null): string | null =>
    r?.k === 'm' && r.a.length === 0 ? r.m : r?.k === 'c' && r.a.length === 0 && typeof r.id === 'string' && /^#c\d+$/.test(r.id) ? r.id.slice(1) : null
  for (const q of queryVars) {
    const v = sameVar(resolveMeta(q, s))
    if (v && v !== q) yours.set(v, q.slice(2))
  }
  // alias spelling as written
  const classes = new Map<string, string[]>()
  for (const t of scope(h.lib.name).templates) {
    const key = JSON.stringify([t.vis, t.body])
    classes.set(key, [...classes.get(key) ?? [], t.id])
  }
  const aliases = new Map<string, string[]>()
  for (const ids of classes.values()) if (ids.length > 1) aliases.set(ids.reduce((a, b) => (b < a ? b : a)), ids)
  const terms = [m.query.res, ...m.query.args, m.cand.res, ...m.cand.args, ...(m.at ? [m.at] : []), ...types].map(z)
  const wanted = terms.reduce((acc, t) => idsIn(t, acc), new Set<string>())
  await loadNames([...wanted].flatMap(id => aliases.get(id) ?? [id]))
  const written = new Set(`${query} ${h.entry.type}`.split(/[\s(){}⦃⦄]+/))
  // names of ids without definitions
  const folded = await namesById(h.lib.name)
  // raw: definition's own names
  let raw = false
  // holes as goals ?0 ?1
  const goal = new Map([...holeMetas].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1))).map((h, i) => [h, `?${i}`]))
  // ambiguous names as the definition's alternative
  const usedIds = [m.cand.res, ...m.cand.args].reduce((acc, t) => idsIn(t, acc), new Set<string>())
  const nameOf = (id: string | Set<string>): string => {
    for (const x of (typeof id === 'string' ? [id] : [...id]).sort((a, b) => Number(usedIds.has(b)) - Number(usedIds.has(a)))) {
      const c = /^#c(\d+)$/.exec(x)
      if (c) return (raw ? undefined : yours.get(`c${c[1]}`)) ?? binder(Number(c[1]))
      const spellings = (aliases.get(x) ?? [x]).map(a => nameCache().get(a)).filter((n): n is string => Boolean(n))
      const n = spellings.find(n => written.has(n) || written.has(n.replace(/^_|_$/g, ''))) ?? spellings.sort((a, b) => a.length - b.length)[0] ?? folded.get(x)
      if (n) return n
    }
    return '?'
  }
  const mentions0 = (t: Term, d = 0): boolean => {
    switch (t.k) {
      case 'b': return t.i === d || t.a.some(x => mentions0(x, d))
      case 'c': case 'm': return t.a.some(x => mentions0(x, d))
      case 'p': return mentions0(t.d, d) || mentions0(t.c, d + 1)
      case 'l': return mentions0(t.b, d + 1)
      default: return false
    }
  }
  // print with precedence
  type Shape = 'atom' | 'app' | 'op'
  const wrap = (x: { s: string, shape: Shape }, upto: Shape) => (x.shape === 'atom' || (upto === 'app' && x.shape === 'app') ? x.s : `(${x.s})`)
  // matched part, bold once
  const rigidOf = (t: Term): Term => {
    switch (t.k) {
      case 'm': return /^c\d+$/.test(t.m) ? { k: 'c', id: `#${t.m}`, a: t.a.map(rigidOf) } : { ...t, a: t.a.map(rigidOf) }
      case 'c': case 'b': return { ...t, a: t.a.map(rigidOf) }
      case 'p': return { k: 'p', d: rigidOf(t.d), c: rigidOf(t.c) }
      case 'l': return { k: 'l', b: rigidOf(t.b) }
      default: return t
    }
  }
  let mark = m.mode === 'anywhere' && m.at ? termKey(m.at) : ''
  const show = (t: Term, env: string[] = []): { s: string, shape: Shape } => {
    if (mark && termKey(rigidOf(t)) === mark) {
      mark = ''
      return { s: `${OPEN}${show(t, env).s}${CLOSE}`, shape: 'atom' }
    }
    const app = (f: string, as: Term[]): { s: string, shape: Shape } => {
      const args = as.map(a => show(a, env))
      const n = holes(f)
      if (n > 0 && args.length >= n) {
        let i = 0
        // operands may be applications
        const filled = f.split('_').flatMap((part, k) => (k === 0 ? [part] : [wrap(args[i++]!, 'app'), part])).filter(Boolean).join(' ')
        const shape: Shape = f.startsWith('_') || f.endsWith('_') ? 'op' : 'atom'
        return args.length > n ? { s: `${shape === 'atom' ? filled : `(${filled})`} ${args.slice(n).map(a => wrap(a, 'atom')).join(' ')}`, shape: 'app' } : { s: filled, shape }
      }
      return args.length === 0 ? { s: f, shape: 'atom' } : { s: `${f} ${args.map(a => wrap(a, 'atom')).join(' ')}`, shape: 'app' }
    }
    switch (t.k) {
      case 'c': return app(nameOf(t.id), t.a)
      case 'm': {
        const c = /^c(\d+)$/.exec(t.m)
        const head = t.m.startsWith('q:') ? t.m.slice(2) : c ? (raw ? undefined : yours.get(t.m)) ?? binder(Number(c[1])) : goal.get(t.m) ?? '_'
        return app(head, t.a)
      }
      case 'b': return app(env[env.length - 1 - t.i] ?? '_', t.a)
      case 'p': {
        const x = fresh(env)
        const c = show(t.c, [...env, x]).s
        return { s: mentions0(t.c) ? `(${x} : ${show(t.d, env).s}) → ${c}` : `${dom(t.d, env)} → ${c}`, shape: 'op' }
      }
      case 'l': {
        const x = fresh(env)
        return { s: `λ ${x} → ${show(t.b, [...env, x]).s}`, shape: 'op' }
      }
      case 'n': return { s: t.v, shape: 'atom' }
      case 's': return { s: 'Type', shape: 'atom' }
      case 'w': return { s: '_', shape: 'atom' }
    }
  }
  const print = (t: Term): string => show(t).s
  // → brackets
  const dom = (t: Term, env: string[] = []): string => (t.k === 'p' || t.k === 'l' ? `(${show(t, env).s})` : show(t, env).s)
  const sig = (args: Term[], res: Term) => [...args.map(a => dom(a)), print(res)].join(' → ')
  // definition's own names
  const asWritten = (f: () => string) => {
    raw = true
    try {
      return f()
    } finally {
      raw = false
    }
  }
  // module params look unused
  const usedLater = (k: number): boolean => {
    const v = m.cand.argVars?.[k]
    if (v == null || own.length !== types.length) return false
    const name = own[v]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const edge = '[\\s(){}⦃⦄]'
    const binder = new RegExp(`[({⦃][^:]*(?<=${edge})${name}(?=${edge}|:)[^:]*:`).exec(h.entry.type)
    // uses after the binder
    return binder !== null && new RegExp(`(^|${edge})${name}($|${edge})`).test(h.entry.type.slice(binder.index + binder[0].length))
  }
  // named args later types mention
  const candSig = () => [...m.cand.args.map((a, k) => {
    const v = m.cand.argVars?.[k]
    const dependent = v != null && own.length === types.length && (!m.cand.marks?.[k] || usedLater(k))
    return dependent ? `(${own[v]} : ${print(a)})` : dom(a)
  }), print(m.cand.res)].join(' → ')
  // goal-style explanation
  const tick = (x: string) => `\`${x.replace(/`/g, "'")}\``
  // marked part as bold code
  const marked = (x: string): string => {
    const [before, rest] = x.split(OPEN)
    if (rest === undefined) return tick(x)
    const [part, after] = rest.split(CLOSE)
    return [before!.trim() && tick(before!.trim()), `**${tick(part!)}**`, after?.trim() && tick(after.trim())].filter(Boolean).join(' ')
  }
  const out: string[] = []
  const asked = m.asked ?? m.query
  out.push(`**Goal** ${tick(sig(asked.args, asked.res))}`)
  // whole type or conclusion
  const part = asWritten(() => (m.mode === 'conclusion' ? print(m.cand.res) : candSig()))
  // argument order, if changed
  const order = m.mode === 'sig' && m.args.some((k, i) => i > 0 && k < m.args[i - 1]!) ? `⟨${m.args.map(k => k + 1).join(', ')}⟩` : ''
  const tags = [m.unfolded ? 'δ' : '', h.via === 'symmetry' ? 'sym' : h.via === 'commutativity' ? 'comm' : h.via ? 'curry' : '', order].filter(Boolean)
  out.push(`**Have** ${marked(part)}${tags.length > 0 ? ` ${tick(`-- ${tags.join(' ')}`)}` : ''}`)
  const below: string[] = []
  // variable specialisations
  const seen = new Set<string>()
  types.forEach((ty, k) => {
    if (ty.k === 'w') return
    const meta = `c${k}`
    if (yours.has(meta)) {
      if (yours.get(meta) !== binder(k)) below.push(`${binder(k)} := ${yours.get(meta)}`)
      return
    }
    const r = z({ k: 'm', m: meta, a: [] })
    if (r.k === 'm' && r.a.length === 0) {
      const key = [meta, r.m].sort().join()
      if (r.m !== meta && !seen.has(key)) below.push(`${binder(k)} := ${print(r)}`)
      seen.add(key)
      return
    }
    below.push(`${binder(k)} := ${print(r)}`)
  })
  for (const q of queryVars) {
    const r = resolveMeta(q, s)
    if (r && !sameVar(r)) below.push(`${q.slice(2)} := ${print(z(r))}`)
  }
  // filled holes
  for (const [hm, g] of goal) {
    const r = z({ k: 'm', m: hm, a: [] })
    if (!(r.k === 'm' && r.m === hm)) below.push(`${g} := ${print(r)}`)
  }
  const lines = [...new Set(below)].filter(l => !/ := _$/.test(l))
  if (lines.length > 0) out.push(tick(lines.join('; ')))
  // new goals under the term to give
  if (m.mode === 'anywhere') return out
  const newGoals = new Map<number, string>()
  m.cand.args.forEach((_, k) => {
    if (!m.args.includes(k) && m.cand.marks?.[k] && !usedLater(k)) newGoals.set(k, `?${goal.size + newGoals.size}`)
  })
  if (newGoals.size === 0) return out
  const xs = m.query.args.map((_, i) => `x${String(i).replace(/\d/g, d => '₀₁₂₃₄₅₆₇₈₉'[Number(d)]!)}`)
  // new goals in the given term's names
  m.args.forEach((k, i) => {
    const v = m.cand.argVars?.[k]
    if (v != null) yours.set(`c${v}`, xs[i]!)
  })
  const as = m.cand.args.map((_, k) => newGoals.get(k) ?? (m.args.includes(k) ? xs[m.args.indexOf(k)]! : '_'))
  while (as.length > 0 && as[as.length - 1] === '_') as.pop()
  const term = [h.entry.name, ...as].join(' ')
  out.push(`**Give** ${tick(xs.length > 0 ? `λ ${xs.join(' ')} → ${term}` : term)}`)
  for (const [k, g] of newGoals) out.push(tick(`${g} : ${print(z(m.cand.args[k]!))}`))
  return out
}
