import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { shift } from '../scripts/lib/agda/canon.ts'
import { ascii, segmentRuns } from '../scripts/lib/agda/fold.ts'
import { decode, encode, termKey } from '../scripts/lib/agda/term.ts'
import type { Sig, Term } from '../scripts/lib/agda/term.ts'
import { resolve, unify } from '../scripts/lib/agda/unify.ts'
import type { Subst } from '../scripts/lib/agda/unify.ts'
import { fc } from './helpers/arb.ts'

const ARITY: Record<string, number> = { a: 0, b: 0, f: 1, g: 2 }

// first-order terms over a, b, f, g and metas
const firstOrder = (metas: string[]) => fc.letrec<{ t: Term }>(tie => ({
  t: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    ...(metas.length ? [fc.constantFrom(...metas).map((m): Term => ({ k: 'm', m, a: [] }))] : []),
    fc.constantFrom('a', 'b').map((id): Term => ({ k: 'c', id, a: [] })),
    fc.tuple(fc.constantFrom('f', 'g'), tie('t'), tie('t')).map(([id, x, y]): Term => ({ k: 'c', id, a: [x, y].slice(0, ARITY[id]) }))
  )
})).t

// full term language, metas x0..x3
const anyTerm = fc.letrec<{ t: Term }>(tie => {
  const args = fc.array(tie('t'), { maxLength: 2 })
  return {
    t: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      fc.constant<Term>({ k: 's' }),
      fc.constant<Term>({ k: 'w' }),
      fc.nat({ max: 99 }).map((v): Term => ({ k: 'n', v: String(v) })),
      fc.tuple(fc.constantFrom('A', 'B', 'C'), args).map(([id, a]): Term => ({ k: 'c', id, a })),
      fc.tuple(fc.nat({ max: 3 }), args).map(([n, a]): Term => ({ k: 'm', m: `x${n}`, a })),
      fc.tuple(fc.nat({ max: 3 }), args).map(([i, a]): Term => ({ k: 'b', i, a })),
      fc.tuple(tie('t'), tie('t')).map(([d, c]): Term => ({ k: 'p', d, c })),
      tie('t').map((b): Term => ({ k: 'l', b }))
    )
  }
}).t

// substitution applied throughout
const zonk = (t: Term, s: Subst): Term => {
  if (t.k === 'm') {
    const v = resolve(t.m, s)!
    return v.k === 'm' ? v : zonk(v, s)
  }
  return t.k === 'c' ? { ...t, a: t.a.map(x => zonk(x, s)) } : t
}

const META_NAMES = ['q:x', 'q:y', 'q:z']

describe('agda properties', () => {
  it('round-trips signatures through encode and decode', () => {
    const sig = fc.tuple(anyTerm, fc.array(fc.tuple(anyTerm, fc.boolean()), { maxLength: 4 }))
      .map(([res, args]): Sig => ({ res, args: args.map(([a]) => a), marks: args.map(([, m]) => m), premises: args.filter(([, m]) => m).length }))
    fc.assert(fc.property(sig, s => {
      assert.deepStrictEqual(decode(encode(s), 'x'), s)
    }))
  })

  it('shifts binders invertibly', () => {
    fc.assert(fc.property(anyTerm, fc.integer({ min: 0, max: 5 }), fc.nat({ max: 3 }), (t, d, cutoff) => {
      assert.strictEqual(shift(t, 0, cutoff), t)
      assert.deepStrictEqual(shift(shift(t, d, cutoff), -d, cutoff), t)
    }))
  })

  it('keys ambiguous ids regardless of set order', () => {
    fc.assert(fc.property(fc.uniqueArray(fc.constantFrom('p', 'q', 'r', 's'), { minLength: 2 }), ids => {
      const key = (xs: string[]): string => termKey({ k: 'c', id: new Set(xs), a: [] })
      assert.strictEqual(key(ids), key([...ids].reverse()))
    }))
  })

  it('unifies only into equal terms, symmetrically', () => {
    const term = firstOrder(META_NAMES)
    fc.assert(fc.property(term, term, (x, y) => {
      const s: Subst = new Map()
      const ok = unify(x, y, s, { steps: 1000 })
      if (ok) assert.deepStrictEqual(zonk(x, s), zonk(y, s))
      assert.strictEqual(unify(y, x, new Map(), { steps: 1000 }), ok)
    }))
  })

  it('unifies a pattern with any instance of it', () => {
    const ground = firstOrder([])
    fc.assert(fc.property(firstOrder(META_NAMES), fc.tuple(ground, ground, ground), (pat, values) => {
      const inst = zonk(pat, new Map(META_NAMES.map((m, i) => [m, values[i]!])))
      assert.ok(unify(pat, inst, new Map(), { steps: 1000 }))
    }))
  })

  it('folds to ascii idempotently', () => {
    fc.assert(fc.property(fc.string({ unit: 'grapheme' }), s => {
      assert.strictEqual(ascii(ascii(s)), ascii(s))
    }))
  })

  it('lists every contiguous run of module segments', () => {
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[A-Z][a-z]{0,4}$/), { minLength: 1, maxLength: 6 }), segs => {
      assert.strictEqual(segmentRuns(segs.join('.')).length, segs.length * (segs.length + 1) / 2)
    }))
  })
})
