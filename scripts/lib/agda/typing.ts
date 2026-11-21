import { decode, instantiate, type Sig, type Term, type Typing } from './term.ts'
import { shift } from './canon.ts'
import { unify, type Budget, type Subst } from './unify.ts'

// erased typing

export interface Signature {
  stored: unknown[]
  typing: Typing
  // omitted module params
  np: number
}

// signatures by id
export type Signatures = (id: string) => Signature | null | undefined

export interface Context {
  sigs: Signatures
  // candidate telescope
  types: Term[]
  // injective constants
  rigid: (id: string) => boolean
  // candidate's constants
  prefer: Set<string>
  // declared variable types
  declared?: Map<string, Term>
  // aliases unfolded
  unfold?: (t: Term & { k: 'c' }) => Term | null
}

const ids = (id: string | Set<string>): string[] => (typeof id === 'string' ? [id] : [...id])

// checking state
export class Checker {
  private n = 0
  private fresh = new Map<string, Term[]>()
  readonly budget: Budget
  private ctx: Context
  readonly s: Subst

  constructor (ctx: Context, s: Subst, steps: number) {
    this.ctx = ctx
    this.s = s
    this.budget = { steps, open: id => !ids(id).every(x => ctx.rigid(x)), ...(ctx.unfold ? { unfold: ctx.unfold } : {}) }
  }

  // meta types
  typeOf (m: string): Term {
    const c = /^c(\d+)$/.exec(m)
    if (c) return this.ctx.types[Number(c[1])] ?? { k: 'm', m: `τ${m}`, a: [] }
    const k = /^(k\d+_)(\d+)$/.exec(m)
    if (k) return this.fresh.get(k[1]!)?.[Number(k[2])] ?? { k: 'w' }
    return this.ctx.declared?.get(m) ?? { k: 'm', m: `τ${m}`, a: [] }
  }

  private signature (id: string | Set<string>): Signature | null {
    const all = ids(id)
    // ambiguous name resolution
    const pick = all.length === 1 ? all : all.filter(x => this.ctx.prefer.has(x))
    if (pick.length !== 1) return null
    return this.ctx.sigs(pick[0]!) ?? null
  }

  // infer, extending s
  infer (t: Term, env: Term[] = []): Term | null {
    if (this.budget.steps < 0) return null
    switch (t.k) {
      case 'm': return this.spine(this.typeOf(t.m), t.a, env)
      case 'b': {
        const ty = env[env.length - 1 - t.i]
        return ty ? this.spine(ty, t.a, env) : null
      }
      case 'c': {
        const sig = this.signature(t.id)
        if (!sig) return null
        const prefix = `k${this.n++}_`
        let d: Sig
        try {
          d = decode(sig.stored, prefix, sig.typing)
        } catch {
          return null
        }
        this.fresh.set(prefix, d.types ?? [])
        const params = d.args.slice(sig.np)
        const vars = (d.argVars ?? []).slice(sig.np)
        if (t.a.length > params.length) return null
        t.a.forEach((a, i) => {
          const v = vars[i]
          if (v != null) unify({ k: 'm', m: `${prefix}${v}`, a: [] }, a, this.s, this.budget)
        })
        for (let i = 0; i < t.a.length; i++) {
          const ta = this.infer(t.a[i]!, env)
          if (ta && !unify(params[i]!, ta, this.s, this.budget)) throw new Mismatch()
        }
        // partial applications
        const rest = params.slice(t.a.length)
        if (rest.length === 0) return d.res
        const later = new Set(vars.slice(t.a.length).filter((v): v is number => v != null).map(v => `${prefix}${v}`))
        const mentions = (x: Term): boolean => {
          switch (x.k) {
            case 'm': return later.has(x.m) || x.a.some(mentions)
            case 'c': case 'b': return x.a.some(mentions)
            case 'p': return mentions(x.d) || mentions(x.c)
            case 'l': return mentions(x.b)
            default: return false
          }
        }
        if ([...rest, d.res].some(mentions)) return null
        return rest.reduceRight<Term>((c, dom) => ({ k: 'p', d: dom, c: shift(c, 1) }), d.res)
      }
      case 'p': {
        this.infer(t.d, env)
        this.infer(t.c, [...env, t.d])
        return { k: 's' }
      }
      case 's': return { k: 's' }
      default: return null
    }
  }

  // apply head type
  private spine (ty: Term, args: Term[], env: Term[]): Term | null {
    let cur: Term = ty
    for (const a of args) {
      if (cur.k !== 'p') return null
      const ta = this.infer(a, env)
      if (ta && !unify(cur.d, ta, this.s, this.budget)) throw new Mismatch()
      cur = instantiate(cur.c, a)
    }
    return cur
  }
}

export class Mismatch extends Error {}

// well-typed match
export const wellTyped = (ctx: Context, s: Subst, queryTerms: Term[], steps = 2000): Subst | null => {
  const t: Subst = new Map(s)
  const ch = new Checker(ctx, t, steps)
  try {
    for (const q of queryTerms) {
      const ty = ch.infer(q)
      if (ty && !unify(ty, { k: 's' }, t, ch.budget)) return null
    }
    for (const [m, v] of s) {
      if (m.startsWith('τ')) continue
      const tm = ch.typeOf(m)
      const tv = ch.infer(v)
      if (tm.k !== 'w' && tv && !unify(tm, tv, t, ch.budget)) return null
    }
  } catch (e) {
    if (e instanceof Mismatch) return null
    throw e
  }
  return t
}
