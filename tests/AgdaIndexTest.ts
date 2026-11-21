import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { ascii, hash, segmentRuns } from '../scripts/lib/agda/fold.ts'
import { chunks, lex, parse, toQuery, type Env, type Notation } from '../scripts/lib/agda/parse.ts'
import { closeStore, cmd, generations, indexSize, libraries, loadIndex, roomFor, wipe } from '../scripts/lib/agda/store.ts'
import { wellTyped, type Signature } from '../scripts/lib/agda/typing.ts'
import { binderNames } from '../scripts/lib/agda/explain.ts'
import { displayType, lookupName, searchAbout, searchNames, searchType, ordered, splitFilters, splitParts, urlFor, type Hit } from '../scripts/lib/agda/search.ts'
import { apply, larger, normalise, TooBig, type NameInfo, type Term } from '../scripts/lib/agda/term.ts'
import { canonicaliser } from '../scripts/lib/agda/canon.ts'
import { merged, setSuc, unify, type Subst } from '../scripts/lib/agda/unify.ts'
import { noRedis, useTestRedis } from './helpers/redis.ts'

const FIXTURES = ['tests/fixtures/agda-cubical.ndjson', 'tests/fixtures/agda-stdlib.ndjson']

const names = (hits: Hit[]) => hits.map(h => `${h.entry.module}.${h.entry.name}`)
const first = (hits: Hit[]) => hits[0]?.entry.name

describe('agda folding', () => {
  it('folds unicode to ascii', () => {
    assert.strictEqual(ascii('isProp→isSet'), 'isProp->isSet')
    assert.strictEqual(ascii('x ≡ y ∙ z'), 'x = y . z')
    assert.strictEqual(ascii('∥ A ∥₁'), '|| A ||1')
    assert.strictEqual(ascii('p ⁻¹'), 'p -1')
    assert.strictEqual(ascii('ℕ'), 'N')
  })

  it('lists every run of whole module segments', () => {
    assert.deepStrictEqual(segmentRuns('Cubical.Foundations._.Prelude'), ['cubical', 'cubical.foundations', 'cubical.foundations.prelude', 'foundations', 'foundations.prelude', 'prelude'])
  })
})

describe('agda terms', () => {
  const table: NameInfo[] = [
    { id: 'level', sort: false },
    { id: 'set', sort: true },
    { id: 'eq' },
    { id: 'mem', np: 1 },
    { id: 'lsuc', lvl: true }
  ]
  table[0]!.id = hash('Agda.Primitive.Level')
  const info = (i: number) => table[i]

  it('numbers the telescope and keeps explicit arguments', () => {
    // {ℓ : Level} {A : Set ℓ} {x y : A} (p : x ≡ y) → y ≡ x
    const raw = ['p', 1, 0, ['c', 0], ['p', 1, 1, ['a', ['c', 1], [0, ['v', 0]]], ['p', 1, 2, ['v', 1], ['p', 1, 3, ['v', 1],
      ['p', 0, 4, ['a', ['c', 2], [0, ['v', 2]], [0, ['v', 3]]], ['a', ['c', 2], [0, ['v', 3]], [0, ['v', 2]]]]]]]]
    // p unused
    assert.deepStrictEqual(normalise(raw, info), [['c', 'eq', ['v', 3], ['v', 2]], ['!', ['c', 'eq', ['v', 2], ['v', 3]]]])
  })

  it('drops module parameters, hidden arguments and levels', () => {
    // (S : _) (x xs : _) → (S ∈ x) xs
    const raw = ['p', 0, 0, ['_'], ['p', 0, 1, ['a', ['c', 1], [0, ['a', ['c', 4], [0, ['v', 0]]]]], ['a', ['c', 3], [1, ['v', 0]], [0, ['v', 0]], [0, ['v', 1]], [0, ['v', 1]]]]]
    assert.deepStrictEqual(normalise(raw, info), [['c', 'mem', ['v', 1], ['v', 1]], ['!', ['_']], ['s']])
  })

  it('numbers inner binders de bruijn', () => {
    // (f : (x : A) → B x) → f ≡ f
    const raw = ['p', 0, 0, ['p', 0, 1, ['f', 'A'], ['a', ['f', 'B'], [0, ['v', 1]]]], ['a', ['c', 2], [0, ['v', 0]], [0, ['v', 0]]]]
    assert.deepStrictEqual(normalise(raw, info), [['c', 'eq', ['v', 0], ['v', 0]], ['p', ['_'], ['_']]])
  })
})

describe('agda unification', () => {
  const c = (id: string, ...a: Term[]): Term => ({ k: 'c', id, a })
  const m = (name: string, ...a: Term[]): Term => ({ k: 'm', m: name, a })

  it('binds variables on both sides', () => {
    const s: Subst = new Map()
    assert.ok(unify(c('eq', m('q:x'), c('zero')), c('eq', c('suc', m('c0')), m('c1')), s, { steps: 100 }))
    assert.deepStrictEqual(s.get('q:x'), c('suc', m('c0')))
    assert.deepStrictEqual(s.get('c1'), c('zero'))
  })

  it('keeps repeated variables consistent', () => {
    assert.ok(!unify(c('eq', m('q:x'), m('q:x')), c('eq', c('a'), c('b')), new Map(), { steps: 100 }))
  })

  it('applies a variable to the trailing arguments', () => {
    const s: Subst = new Map()
    assert.ok(unify(m('c0', m('q:x')), c('f', c('a'), c('b')), s, { steps: 100 }))
    assert.deepStrictEqual(s.get('c0'), c('f', c('a')))
  })

  it('refuses cycles and escaping binders', () => {
    assert.ok(!unify(m('q:x'), c('suc', m('q:x')), new Map(), { steps: 100 }))
    assert.ok(!unify({ k: 'l', b: m('q:x') }, { k: 'l', b: { k: 'b', i: 0, a: [] } }, new Map(), { steps: 100 }))
  })

  it('solves P x against a term over x with a λ, and β-reduces it later', () => {
    const b = (i: number, ...a: Term[]): Term => ({ k: 'b', i, a })
    const s: Subst = new Map()
    // λ x → P x  against  λ x → f x a
    assert.ok(unify({ k: 'l', b: m('q:P', b(0)) }, { k: 'l', b: c('f', b(0), c('a')) }, s, { steps: 100 }))
    assert.deepStrictEqual(s.get('q:P'), { k: 'l', b: c('f', b(0), c('a')) })
    // P b afterwards is f b a
    assert.ok(unify(m('q:P', c('b')), c('f', c('b'), c('a')), s, { steps: 100 }))
    assert.ok(!unify(m('q:P', c('b')), c('f', c('b'), c('z')), s, { steps: 100 }))
  })

  it('matches literals against suc', () => {
    setSuc(new Set(['suc']))
    const s: Subst = new Map()
    assert.ok(unify({ k: 'n', v: '2' }, c('suc', m('q:n')), s, { steps: 100 }))
    assert.deepStrictEqual(s.get('q:n'), { k: 'n', v: '1' })
    setSuc(new Set())
  })

  it('refuses matches whose variables take terms of another type', () => {
    const rigid = new Set(['eq', 'K', 'List', 'Nat', 'zero'])
    const sigs = new Map<string, Signature>([['zero', { stored: [['c', 'Nat']], typing: { types: [], argVars: [] }, np: 0 }]])
    const ctx = (types: Term[], declared = new Map<string, Term>()) => ({ sigs: (id: string) => sigs.get(id), types, rigid: (id: string) => rigid.has(id), prefer: new Set<string>(), declared })
    // elim₁ against path s
    const fn = { k: 'p', d: c('K'), c: m('c2') } as Term
    const path = new Map<string, Term>([['q:s', c('eq', m('q:a'), m('q:b'))]])
    assert.strictEqual(wellTyped(ctx([fn], path), new Map([['c0', m('q:s')]]), [], 100), null)
    assert.ok(wellTyped(ctx([c('eq', m('c3'), m('c4'))], path), new Map([['c0', m('q:s')]]), [], 100))
    // untyped and unfolding pass
    assert.ok(wellTyped(ctx([fn]), new Map([['c0', m('q:t')]]), [], 100))
    const lists = new Map<string, Term>([['q:s', c('List', c('Nat'))]])
    assert.ok(wellTyped(ctx([c('List', c('Carrier', m('c5')))], lists), new Map([['c0', m('q:s')]]), [], 100))
    assert.strictEqual(wellTyped(ctx([c('eq', m('c3'), m('c4'))], lists), new Map([['c0', m('q:s')]]), [], 100), null)
    // term-bound variables
    assert.strictEqual(wellTyped(ctx([fn]), new Map([['c0', c('zero')]]), [], 100), null)
    const learnt = wellTyped(ctx([m('c1')]), new Map([['c0', c('zero')]]), [], 100)
    assert.deepStrictEqual(learnt?.get('c1'), c('Nat'))
  })

  it('reads binder names off a printed type', () => {
    assert.deepStrictEqual(binderNames('{ℓ : Level} {A : Set ℓ} {x y : A} (p : x ≡ y) → isProp (x ≡ y) → Σ (λ (z : A) → z ≡ x)'), ['ℓ', 'A', 'x', 'y', 'p'])
    assert.deepStrictEqual(binderNames('{R : Ring ℓ} {I = I₁ : IdealsIn R} ⦃ _ : P ⦄ → ⟨ R ⟩'), ['R', 'I₁', '_'])
  })

  it('bounds β-reduction', () => {
    // λ x → x x applied to itself
    const self: Term = { k: 'l', b: { k: 'b', i: 0, a: [{ k: 'b', i: 0, a: [] }] } }
    assert.throws(() => apply(self, [self]), TooBig)
    // small ones reduce
    const twice: Term = { k: 'l', b: { k: 'l', b: { k: 'b', i: 1, a: [{ k: 'b', i: 1, a: [{ k: 'b', i: 0, a: [] }] }] } } }
    assert.deepStrictEqual(apply(twice, [{ k: 'c', id: 'f', a: [] }, { k: 'c', id: 'a', a: [] }]), { k: 'c', id: 'f', a: [{ k: 'c', id: 'f', a: [{ k: 'c', id: 'a', a: [] }] }] })
  })

  it('measures shared terms only up to a cap', () => {
    // shared dag, exponential tree
    let t: Term = { k: 'c', id: 'a', a: [] }
    for (let i = 0; i < 40; i++) t = { k: 'c', id: 'f', a: [t, t] }
    const start = performance.now()
    assert.ok(larger({ args: [], res: t }, 500))
    assert.ok(!larger({ args: [], res: { k: 'c', id: 'f', a: [] } }, 500))
    assert.ok(performance.now() - start < 50)
  })

  it('keeps named query variables distinct, rigid candidate binders too', () => {
    assert.ok(merged(new Map([['q:p', m('c0')], ['q:q', m('c0')]])))
    assert.ok(merged(new Map([['q:p', c('#c2')], ['q:q', c('#c2')]])))
    assert.ok(!merged(new Map([['q:p', c('#c2')], ['q:q', c('#c3')]])))
  })

  it('keeps candidate variables in telescope order', () => {
    // Y can't become isProp (F y)
    assert.ok(!ordered(new Map([['q:A', c('F', m('c1'))], ['c0', c('isProp', m('q:A'))]])))
    assert.ok(ordered(new Map([['q:A', c('F', m('c0'))], ['c1', c('isProp', m('q:A'))]])))
    // merged variables go either way
    assert.ok(ordered(new Map([['c0', m('c1')]])))
  })

  it('matches ambiguous constants by any of their ids', () => {
    assert.ok(unify({ k: 'c', id: new Set(['a', 'b']), a: [] }, c('b'), new Map(), { steps: 10 }))
  })
})

describe('agda canonical forms', () => {
  const c = (id: string, ...a: Term[]): Term => ({ k: 'c', id, a })
  const m = (name: string, ...a: Term[]): Term => ({ k: 'm', m: name, a })
  const b = (i: number, ...a: Term[]): Term => ({ k: 'b', i, a })
  const lam = (body: Term): Term => ({ k: 'l', b: body })
  // ≡, Path and transport aliases
  const canon = canonicaliser([
    { id: 'eq', vis: [false, false], body: c('PathP', lam(m('t:1'))) },
    { id: 'Path', vis: [false, true, true, true], body: c('PathP', lam(m('t:1')), m('t:2'), m('t:3')) },
    { id: 'transport', vis: [false, false, false, true, true], body: c('transp', lam(m('t:3', b(0))), c('i0'), m('t:4')) }
  ])
  const one = (t: Term) => canon({ args: [], res: t }).res

  it('folds primitives into the alias with the fewest arguments', () => {
    assert.deepStrictEqual(one(c('PathP', lam(c('A')), c('x'), c('y'))), c('eq', c('x'), c('y')))
    assert.deepStrictEqual(one(c('Path', c('A'), c('x'), c('y'))), c('eq', c('x'), c('y')))
    assert.deepStrictEqual(one(c('transp', lam(m('q:p', b(0))), c('i0'), c('a'))), c('transport', m('q:p'), c('a')))
  })

  it('keeps dependent families as they are', () => {
    const dependent = c('PathP', lam(c('B', c('f', b(0)))), c('x'), c('y'))
    assert.deepStrictEqual(one(dependent), dependent)
  })

  it('folds under binders', () => {
    assert.deepStrictEqual(one(lam(c('PathP', lam(c('A')), b(0), c('y')))), lam(c('eq', b(0), c('y'))))
  })
})

describe('agda query parsing', () => {
  const op = (name: string, id: string, level = 20, assoc: Notation['assoc'] = 'non'): [string, Notation[]] => [name, [{ name, ids: new Set([id]), assoc, level }]]
  const env: Env = {
    names: new Map([
      op('_=_', 'eq', 4), op('_._', 'comp', 30, 'right'), op('_+_', 'plus', 6, 'left'), op('_*_', 'times', 7, 'left'),
      op('||_||1', 'trunc'), op('_-1', 'inv', 40), op('sym', 'sym'), op('suc', 'suc'), op('zero', 'zero'), op('isProp', 'isProp'), op('fst', 'fst'),
      op('fun', 'fun'), op('Iso.fun', 'fun'), op('map', 'map'), op('snd', 'snd'), op('if_then_else_', 'ite', 0),
      ['_,_', [{ name: '_,_', ids: new Set(['pair']), assoc: 'right', level: 4, fields: [new Set(['fst']), new Set(['snd'])] }]],
      // Σ[ x ∈ A ] B syntax, infix 2
      ['Sigma-syntax', [{ name: 'Sigma-syntax', ids: new Set(['sigma']), assoc: 'non', level: 2, syntax: [{ k: 'part', part: 'Sigma[' }, { k: 'bind', hole: 1, v: 0 }, { k: 'part', part: '<-' }, { k: 'hole', n: 0 }, { k: 'part', part: ']' }, { k: 'hole', n: 1 }] }]],
      // Sigma X Y = Σ {X} Y
      ['Sigma', [{ name: 'Sigma', ids: new Set(['sigma']), assoc: 'right', level: -1, keep: [[1], 2], syntax: [{ k: 'part', part: 'Sigma' }, { k: 'bind', hole: 1, v: 0 }, { k: 'part', part: '꞉' }, { k: 'hole', n: 0 }, { k: 'part', part: ',' }, { k: 'hole', n: 1 }] }]]
    ]),
    concrete: new Set(['N']),
    nat: { zero: new Set(['zero']), suc: new Set(['suc']) }
  }
  const parts = new Set(['=', '.', '+', '*', '||', '||1', '-1', 'Sigma[', '<-', ']', '꞉', ',', 'if', 'then', 'else'])
  const show = (t: Term): string => {
    switch (t.k) {
      case 'c': return `${[...(typeof t.id === 'string' ? [t.id] : t.id)].join('|')}${t.a.length ? `(${t.a.map(show).join(' ')})` : ''}`
      case 'm': return `${t.m.startsWith('h') ? '_' : t.m.slice(2)}${t.a.length ? `(${t.a.map(show).join(' ')})` : ''}`
      case 'b': return `#${t.i}`
      case 'p': return `(${show(t.d)} -> ${show(t.c)})`
      case 'l': return `\\${show(t.b)}`
      case 'n': return t.v
      default: return t.k
    }
  }
  const read = (q: string): string[] => {
    const toks = lex(chunks(q), w => env.names.has(w), parts)
    return parse(toks, env).map(p => {
      const { sig } = toQuery(p, env)
      return [...sig.args.map(show), show(sig.res)].join(' ; ')
    })
  }

  it('splits unspaced operators at known parts', () => {
    assert.deepStrictEqual(lex(chunks('p.q=x*y'), () => false, parts), ['p', '.', 'q', '=', 'x', '*', 'y'])
    assert.deepStrictEqual(lex(chunks('isProp->isSet A'), w => w === 'isProp->isSet', parts), ['isProp->isSet', 'A'])
  })

  it('parses by the indexed fixities', () => {
    assert.deepStrictEqual(read('sym (p . q) = sym q . sym p'), ['eq(sym(comp(p q)) comp(sym(q) sym(p)))'])
    assert.deepStrictEqual(read('a + b * c = a'), ['eq(plus(a times(b c)) a)'])
    assert.deepStrictEqual(read('a + b + c = a'), ['eq(plus(plus(a b) c) a)'])
    assert.deepStrictEqual(read('p . q . r = p'), ['eq(comp(p comp(q r)) p)'])
  })

  it('reads holes, postfix and closed notations', () => {
    assert.deepStrictEqual(read('_ . _'), ['comp(_ _)'])
    assert.deepStrictEqual(read('p -1 -1 = p'), ['eq(inv(inv(p)) p)'])
    assert.deepStrictEqual(read('||A|| -> A'), ['trunc(A) ; A'])
  })

  it('reads binders, sorts and Σ syntax', () => {
    assert.deepStrictEqual(read('{A : Type} (x : A) -> x = x'), ['A ; eq(x x)'])
    assert.deepStrictEqual(read('forall x -> suc x = x'), ['_ ; eq(suc(x) x)'])
    assert.deepStrictEqual(read('Sigma[ x <- A ] isProp x -> A'), ['sigma(A \\isProp(#0)) ; A'])
    assert.deepStrictEqual(read('Σ[x ∈ A] isProp x -> A'), ['sigma(A \\isProp(#0)) ; A'])
    assert.deepStrictEqual(read('(f : (x : A) -> B) -> A'), ['(A -> B) ; A'])
  })

  it('reads syntax declarations, keeping the arguments an alias passes on', () => {
    assert.deepStrictEqual(read('(Σ x ꞉ X , isProp x) -> X'), ['sigma(\\isProp(#0)) ; X'])
  })

  it('reads sections as functions', () => {
    assert.deepStrictEqual(read('map (_+ 1) xs = xs'), ['eq(map(\\plus(#0 1) xs) xs)'])
    assert.deepStrictEqual(read('map (1 +_) xs = xs'), ['eq(map(\\plus(1 #0) xs) xs)'])
  })

  it('reads postfix projections and qualified names', () => {
    assert.deepStrictEqual(read('u .fst = v .fst -> u = v'), ['eq(fst(u) fst(v)) ; eq(u v)'])
    assert.deepStrictEqual(read('Iso.fun e x = x'), ['eq(fun(e x) x)'])
  })

  it('reads pattern binders as fields of a fresh variable', () => {
    assert.deepStrictEqual(read('((a , b) : S) -> a = b'), ['S ; eq(fst(§p0) snd(§p0))'])
    assert.deepStrictEqual(read('((a , (b , c)) : S) -> c = a'), ['S ; eq(snd(snd(§p0)) fst(§p0))'])
  })

  it('reads partial mixfix sections, and applies them', () => {
    assert.deepStrictEqual(read('(if_then y else z) x = x'), ['eq(ite(x y z) x)'])
    assert.deepStrictEqual(read('(if x then_else z) y = y'), ['eq(ite(x y z) y)'])
  })

  it('drops implicit, instance and named arguments', () => {
    assert.deepStrictEqual(read('sym {x = a} {y = b} p = q'), ['eq(sym(p) q)'])
    assert.deepStrictEqual(read('sym ⦃ i ⦄ p = q'), ['eq(sym(p) q)'])
    assert.deepStrictEqual(read('sym {{ i }} p = q'), ['eq(sym(p) q)'])
  })

  it('reads binders with modalities, labels and instance braces', () => {
    assert.deepStrictEqual(read('.(m = n) -> m = n'), ['eq(m n) ; eq(m n)'])
    assert.deepStrictEqual(read('(@0 x : A) -> x = x'), ['A ; eq(x x)'])
    assert.deepStrictEqual(read('{A = X : Type} -> X -> X'), ['X ; X'])
    assert.deepStrictEqual(read('{{ i : isProp A }} -> A -> A'), ['A ; A'])
    assert.deepStrictEqual(read('forall {x} .y -> x = y'), ['_ ; eq(x y)'])
  })

  it('reads literals in every spelling, and zero and suc as literals', () => {
    assert.deepStrictEqual(read('0x2A + 1_000 = 0b11'), ['eq(plus(42 1000) 3)'])
    assert.deepStrictEqual(read('suc (suc zero) = 2'), ['eq(2 2)'])
    assert.deepStrictEqual(read('suc n = 1'), ['eq(suc(n) 1)'])
  })

  it('reads lambdas, and gives up on what a search cannot use', () => {
    assert.deepStrictEqual(read('map (λ x → x) xs = xs'), ['eq(map(\\#0 xs) xs)'])
    assert.deepStrictEqual(read('map (λ {A} (x : A) → x) xs = xs'), ['eq(map(\\#0 xs) xs)'])
    assert.deepStrictEqual(read('map (λ { a → a }) xs = xs'), ['eq(map(w xs) xs)'])
    assert.deepStrictEqual(read('map (λ ()) xs = xs'), ['eq(map(w xs) xs)'])
    assert.deepStrictEqual(read('map (record { fst = a }) xs = xs'), ['eq(map(w xs) xs)'])
  })

  it('treats single letters as variables, but not type names like N', () => {
    const toks = lex(chunks('N -> x = x'), w => env.names.has(w), parts)
    assert.deepStrictEqual(parse(toks, env).map(p => toQuery(p, env).unknown), [['N']])
  })

  it('splits loogle style parts at commas', () => {
    assert.deepStrictEqual(splitParts('sym, "distr", (a , b) = c'), ['sym', '"distr"', '(a , b) = c'])
  })
})

describe('agda index', { skip: noRedis }, () => {
  before(async () => {
    useTestRedis('index')
    await wipe()
    await loadIndex(FIXTURES, true)
  })

  after(async () => {
    await wipe()
    await closeStore()
  })

  describe('loading', () => {
    it('loads every library once', () => {
      assert.deepStrictEqual(libraries().map(l => l.name), ['cubical', 'stdlib'])
      // fst ships with both
      assert.strictEqual(indexSize(), 39 + 24 - 1)
    })

    // full scan
    const keys = async (pattern: string) => {
      let n = 0
      let cursor = '0'
      do {
        const [next, found] = await cmd<[string, string[]]>(['SCAN', cursor, 'MATCH', pattern, 'COUNT', '10000'])
        n += found.length
        cursor = next
      } while (cursor !== '0')
      return n
    }

    it('skips unchanged libraries and swaps generations', async () => {
      const before = generations()
      assert.deepStrictEqual(await loadIndex(FIXTURES), { loaded: [], count: indexSize(), skipped: [] })
      assert.deepStrictEqual(generations(), before)
      assert.deepStrictEqual((await loadIndex(FIXTURES, true)).loaded, ['cubical', 'stdlib'])
      const after = generations()
      assert.notStrictEqual(after.cubical, before.cubical)
      assert.strictEqual(await keys(`${process.env.AGDA_REDIS_PREFIX}:d:cubical:${before.cubical}:*`), 0)
      assert.strictEqual(await keys(`${process.env.AGDA_REDIS_PREFIX}:d:cubical:${after.cubical}:*`), 39)
      assert.strictEqual(first(await lookupName('symDistr')), 'symDistr')
    })

    it('reloads only the library that changed', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agda-'))
      const bumped = join(dir, 'stdlib.ndjson')
      const [meta, ...rest] = readFileSync(FIXTURES[1]!, 'utf8').split('\n')
      await writeFile(bumped, [JSON.stringify({ meta: { ...(JSON.parse(meta!) as { meta: object }).meta, commit: 'f'.repeat(40) } }), ...rest].join('\n'))
      const before = generations()
      assert.deepStrictEqual((await loadIndex([FIXTURES[0]!, bumped])).loaded, ['stdlib'])
      assert.strictEqual(generations().cubical, before.cubical)
      assert.strictEqual(libraries().find(l => l.name === 'stdlib')?.commit, 'f'.repeat(40))
      assert.strictEqual(indexSize(), 62)
    })

    it('reloads a library a new indexer built', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agda-'))
      const rebuilt = join(dir, 'cubical.ndjson')
      const [meta, ...rest] = readFileSync(FIXTURES[0]!, 'utf8').split('\n')
      await writeFile(rebuilt, [JSON.stringify({ meta: { ...(JSON.parse(meta!) as { meta: object }).meta, build: 'next' } }), ...rest].join('\n'))
      await loadIndex(FIXTURES)
      assert.deepStrictEqual((await loadIndex([rebuilt, FIXTURES[1]!])).loaded, ['cubical'])
      assert.strictEqual(libraries().find(l => l.name === 'cubical')?.build, 'next')
      assert.deepStrictEqual((await loadIndex([rebuilt, FIXTURES[1]!])).loaded, [])
    })

    it('skips malformed or missing files, and keeps the old index when nothing loads', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agda-'))
      const bad = join(dir, 'bad.ndjson')
      await writeFile(bad, '{"oops":1}\n')
      const { skipped } = await loadIndex([...FIXTURES, bad, join(dir, 'missing.ndjson.gz')], true)
      assert.strictEqual(skipped.length, 2)
      assert.match(skipped[0]!, /bad\.ndjson: malformed/)
      assert.strictEqual(indexSize(), 62)
      const before = generations()
      await assert.rejects(loadIndex([bad], true), /malformed/)
      assert.deepStrictEqual(generations(), before)
      assert.strictEqual(first(await lookupName('symDistr')), 'symDistr')
    })

    it('keeps answering while a reload swaps generations', async () => {
      const reload = loadIndex(FIXTURES, true)
      let done = false
      void reload.then(() => (done = true))
      const seen: number[] = []
      while (!done) seen.push((await lookupName('symDistr')).length + (await lookupName('_++_')).length)
      await reload
      assert.ok(seen.length > 0 && seen.every(n => n >= 2), JSON.stringify(seen))
    })

    it('sweeps generations a crash left behind', async () => {
      // crash leftover
      const prefix = process.env.AGDA_REDIS_PREFIX!
      await cmd(['SADD', `${prefix}:gens`, 'cubical:999'])
      await cmd(['HSET', `${prefix}:d:cubical:999:0`, 'n', 'orphan'])
      await loadIndex(FIXTURES)
      assert.strictEqual(await keys(`${prefix}:d:cubical:999:*`), 0)
      assert.ok(!(await cmd<string[]>(['SMEMBERS', `${prefix}:gens`])).includes('cubical:999'))
    })

    it('skips a reload that would not fit under maxmemory', () => {
      const mb = 1048576
      assert.strictEqual(roomFor(100 * mb, 0, 50 * mb), null)
      assert.strictEqual(roomFor(100 * mb, 256 * mb, 50 * mb), null)
      assert.match(roomFor(200 * mb, 256 * mb, 50 * mb)!, /^not enough redis memory, 200MB used of 256MB and it needs about 50MB$/)
    })

    it('reads gzipped files', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agda-'))
      const gz = join(dir, 'stdlib.ndjson.gz')
      await writeFile(gz, gzipSync(readFileSync(FIXTURES[1]!)))
      await loadIndex([FIXTURES[0]!, gz], true)
      assert.strictEqual(indexSize(), 62)
    })
  })

  describe('names', () => {
    it('finds exact names typed in ascii or pasted in unicode', async () => {
      assert.deepStrictEqual(names(await lookupName('isProp->isSet')), ['Cubical.Foundations.Prelude.isProp→isSet'])
      assert.deepStrictEqual(names(await lookupName('isProp→isSet')), ['Cubical.Foundations.Prelude.isProp→isSet'])
    })

    it('finds mixfix names without underscores, and ∙ despite the module separator', async () => {
      assert.ok(names(await lookupName('++')).includes('Data.List.Base._++_'))
      assert.deepStrictEqual(names(await lookupName('_∙_')), ['Cubical.Foundations.Prelude._∙_'])
    })

    it('narrows by a qualified suffix', async () => {
      assert.deepStrictEqual(names(await lookupName('Iso.fun')), ['Cubical.Foundations.Isomorphism.Iso.fun'])
      assert.deepStrictEqual(names(await lookupName('Prelude.sym')), ['Cubical.Foundations.Prelude.sym'])
    })

    it('finds renamed re-exports', async () => {
      const [h] = await lookupName('hcomp')
      assert.strictEqual(h?.entry.alias, 'Agda.Primitive.Cubical.primHComp')
    })

    it('ranks exact, prefix, word starts, then substrings', async () => {
      const found = (await searchNames('isprop')).map(h => h.entry.name)
      assert.strictEqual(found[0], 'isProp')
      assert.ok(found.indexOf('isProp→isSet') < found.indexOf('isPropPropTrunc') || found.includes('isProp→isSet'))
      assert.ok((await searchNames('set')).map(h => h.entry.name).includes('isProp→isSet'))
    })

    it('falls back to subsequences', async () => {
      assert.deepStrictEqual((await searchNames('symdtr')).map(h => h.entry.name), ['symDistr'])
    })

    it('matches module segments', async () => {
      assert.ok((await searchNames('grouppoidlaws')).length === 0)
      assert.ok((await searchNames('groupoidlaws')).map(h => h.entry.name).includes('symDistr'))
    })
  })

  describe('types', () => {
    it('reads PathP and Path as the ≡ they abbreviate', async () => {
      assert.strictEqual(first(await searchType('PathP (λ i → A) (sym (p . q)) _')), 'symDistr')
      assert.strictEqual(first(await searchType('Path A (sym (p . q)) (sym q . sym p)')), 'symDistr')
    })

    it('fills holes with whole subterms', async () => {
      assert.strictEqual(first(await searchType('sym (p . q) = _ . _')), 'symDistr')
      assert.strictEqual(first(await searchType('sym (cong f p) = _')), 'sym-cong')
    })

    it('matches whole signatures with arguments in any order', async () => {
      assert.strictEqual(first(await searchType('isProp A -> isSet A')), 'isProp→isSet')
      assert.strictEqual(first(await searchType('(A -> B) -> List A -> List B')), 'map')
      assert.ok(names(await searchType('Iso A B -> A = B')).includes('Cubical.Foundations.Isomorphism.isoToPath'))
    })

    it('finds statements through stdlib abstractions, unfolded once', async () => {
      assert.strictEqual(first(await searchType('x /= y -> y /= x')), '≢-sym')
      assert.ok(names(await searchType('(xs ++ ys) ++ zs = xs ++ (ys ++ zs)')).some(n => n.endsWith('++-assoc')))
    })

    it('drops module parameters, so membership reads as written', async () => {
      assert.strictEqual(first(await searchType('x <- xs -> x <- xs ++ ys')), '∈-++⁺ˡ')
      assert.strictEqual(first(await searchType('x ∈ xs → x ∈ xs ++ ys')), '∈-++⁺ˡ')
    })

    it('reads ||A||, Σ syntax and postfix inverses', async () => {
      assert.ok(names(await searchType('isProp B -> (A -> B) -> ||A|| -> B')).includes('Cubical.HITs.PropositionalTruncation.Properties.rec'))
      assert.ok(names(await searchType('Sigma[ x <- A ] B x -> A')).includes('Agda.Builtin.Sigma.Σ.fst'))
    })

    it('matches symmetric statements either way round', async () => {
      const hits = await searchType('p . refl = p')
      assert.strictEqual(first(hits), 'rUnit')
      assert.strictEqual(hits[0]!.via, 'symmetry')
    })

    it('matches only conclusions after |-, unfolded ones lower', async () => {
      const found = (await searchType('|- isProp _')).map(h => h.entry.name)
      assert.deepStrictEqual(found.slice(0, 4).sort(), ['isProp×', 'isPropPropTrunc', 'isPropΠ', 'isPropΣ'].sort())
      assert.ok(found.includes('isProp→isSet'))
      assert.ok(!(await searchType('|- _ . _')).length)
    })

    it('needs every comma separated part', async () => {
      assert.deepStrictEqual((await searchType('sym, "distr"')).map(h => h.entry.name), ['symDistr'])
      assert.deepStrictEqual((await searchType('isProp, "Sigma"')).map(h => h.entry.name).sort(), ['isPropΣ', 'isSetΣ'])
    })

    it('finds nothing for unknown names', async () => {
      assert.deepStrictEqual(await searchType('isFrobnicated A'), [])
    })

    it('gives up on long queries', async () => {
      assert.deepStrictEqual(await searchType(`${'A -> '.repeat(80)}A`), [])
    })
  })

  describe('about', () => {
    it('needs every name, -name excludes', async () => {
      assert.ok(names(await searchAbout('sym cong')).includes('Relation.Binary.PropositionalEquality.Properties.sym-cong'))
      assert.ok(!names(await searchAbout('isProp -isSet')).includes('Cubical.Foundations.Prelude.isProp→isSet'))
      assert.ok(names(await searchAbout('isProp isSet')).includes('Cubical.Foundations.Prelude.isProp→isSet'))
    })
  })

  describe('filters', () => {
    const split = splitFilters

    it('splits filters off the query', () => {
      assert.strictEqual(split('isProp A lib:cubical kind:fun in:Prelude').query, 'isProp A')
      assert.strictEqual(split('isProp A').filter, '')
      assert.match(split('sym kind:lemma').error!, /^Unknown kind `lemma`, try fun, data, record/)
      assert.match(split('sym lib:nope').error!, /^Unknown library `nope`, try cubical, stdlib/)
    })

    it('narrows by library, prefixes and lists allowed', async () => {
      assert.deepStrictEqual(names(await lookupName('sym', split('lib:std').filter)), ['Relation.Binary.PropositionalEquality.Core.sym'])
      assert.deepStrictEqual(names(await lookupName('sym', split('-lib:cubical').filter)), ['Relation.Binary.PropositionalEquality.Core.sym'])
      assert.strictEqual((await lookupName('sym', split('lib:stdlib,cubical').filter)).length, 2)
    })

    it('narrows by kind and whole module segments', async () => {
      assert.deepStrictEqual(names(await lookupName('fun', split('kind:field').filter)), ['Cubical.Foundations.Isomorphism.Iso.fun'])
      assert.deepStrictEqual(names(await searchType('isProp A -> isSet A', split('in:Cubical.Foundations').filter)), ['Cubical.Foundations.Prelude.isProp→isSet'])
      assert.deepStrictEqual(await searchType('isProp A -> isSet A', split('in:Foundation').filter), [])
      assert.ok((await searchNames('', split('in:HLevels').filter)).every(h => h.entry.module === 'Cubical.Foundations.HLevels'))
    })
  })

  describe('display', () => {
    it('links to source lines at the indexed commit, and agda builtins in agda', async () => {
      const [h] = await lookupName('symDistr')
      assert.match(urlFor(h!), /^https:\/\/github\.com\/agda\/cubical\/blob\/[0-9a-f]{40}\/Cubical\/Foundations\/GroupoidLaws\.agda#L\d+$/)
      const [f] = await lookupName('fst')
      assert.match(urlFor(f!), /^https:\/\/github\.com\/agda\/agda\/blob\/v2\.9\.0\/src\/data\/lib\/prim\/Agda\/Builtin\/Sigma\.agda#L\d+$/)
    })
  })
})

describe('agda display', () => {
  it('drops level binders, renames generated names and says Type for cubical', () => {
    assert.strictEqual(displayType('{ℓ : Level} {A : Set ℓ} → isProp A → isSet A', 'cubical'), '{A : Type ℓ} → isProp A → isSet A')
    assert.strictEqual(displayType('{A.a : Level} {A : Set A.a} (x : A) → x ≡ x', 'stdlib'), '{A : Set a} (x : A) → x ≡ x')
  })

  it('keeps record qualifiers that are not binders', () => {
    assert.strictEqual(displayType('(f : Inverse A B) → Inverse.from f ≡ g'), '(f : Inverse A B) → Inverse.from f ≡ g')
  })
})
