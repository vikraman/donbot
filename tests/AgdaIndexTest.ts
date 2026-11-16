import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'

import { ascii, displayType, indexSize, libraries, loadIndex, lookupName, searchAbout, searchNames, searchType, setIndex, urlFor, type Hit, type IndexFile } from '../scripts/lib/agdaIndex.ts'

const FIXTURES = ['tests/fixtures/agda-cubical.json', 'tests/fixtures/agda-stdlib.json']

// module.name of each hit
const names = (hits: Hit[]): string[] => hits.map(h => `${h.entry.module.replace(/\._$/, '')}.${h.entry.name}`)

describe('agda index', () => {
  before(async () => {
    await loadIndex(FIXTURES)
  })

  it('loads index files', () => {
    assert.deepStrictEqual(libraries().map(l => [l.name, l.count]), [['cubical', 33], ['stdlib', 10]])
    assert.strictEqual(indexSize(), 43)
  })

  it('loads gzipped index files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agda-index-'))
    try {
      const gz = join(dir, 'stdlib.json.gz')
      await writeFile(gz, gzipSync(await readFile(FIXTURES[1]!)))
      await loadIndex([gz])
      assert.deepStrictEqual(libraries().map(l => [l.name, l.count]), [['stdlib', 10]])
    } finally {
      await rm(dir, { recursive: true })
      await loadIndex(FIXTURES)
    }
  })

  it('folds unicode to ascii', () => {
    assert.strictEqual(ascii('isProp→isSet'), 'isProp->isSet')
    assert.strictEqual(ascii('∥_∥₁'), '||_||1')
    assert.strictEqual(ascii('isPropΣ'), 'isPropSigma')
    assert.strictEqual(ascii('_⁻¹'), '_-1')
  })

  describe('names', () => {
    it('finds exact names typed in ascii or pasted in unicode', () => {
      assert.deepStrictEqual(names(lookupName('isProp->isSet')), ['Cubical.Foundations.Prelude.isProp→isSet'])
      assert.deepStrictEqual(names(lookupName('isProp→isSet')), ['Cubical.Foundations.Prelude.isProp→isSet'])
      assert.deepStrictEqual(names(lookupName('isPropSigma')), ['Cubical.Foundations.HLevels.isPropΣ'])
      assert.deepStrictEqual(names(lookupName('_-1')), ['Cubical.Foundations.GroupoidLaws._⁻¹'])
    })

    it('finds mixfix names without underscores', () => {
      assert.deepStrictEqual(names(lookupName('++')).sort(), ['Cubical.Data.List.Base._++_', 'Data.List.Base._++_'])
    })

    it('finds names with ∙, which folds to the module separator', () => {
      assert.deepStrictEqual(names(lookupName('_∙_')), ['Cubical.Foundations.Prelude._∙_'])
      assert.deepStrictEqual(names(lookupName('∙')), ['Cubical.Foundations.Prelude._∙_'])
      assert.deepStrictEqual(names(lookupName('Prelude._∙_')), ['Cubical.Foundations.Prelude._∙_'])
    })

    it('takes a full module name as that module', () => {
      assert.deepStrictEqual(names(lookupName('Data.List.Base._++_')), ['Data.List.Base._++_'])
    })

    it('narrows by a qualified suffix', () => {
      assert.deepStrictEqual(names(lookupName('fun')).length, 2)
      assert.deepStrictEqual(names(lookupName('Iso.fun')), ['Cubical.Foundations.Isomorphism.Iso.fun'])
      assert.deepStrictEqual(names(lookupName('Prelude.sym')), ['Cubical.Foundations.Prelude.sym'])
      assert.deepStrictEqual(names(lookupName('Nope.sym')), [])
    })

    it('ranks fuzzy matches exact, then prefix, then substring', () => {
      const hits = names(searchNames('iso'))
      assert.strictEqual(hits[0], 'Cubical.Foundations.Isomorphism.Iso')
      assert.ok(hits.indexOf('Cubical.Foundations.Isomorphism.isoToPath') < hits.indexOf('Cubical.Foundations.Transport.pathToIso'))
      assert.deepStrictEqual(names(searchNames('iso path')).slice(0, 2).sort(), ['Cubical.Foundations.Isomorphism.isoToPath', 'Cubical.Foundations.Transport.pathToIso'])
    })

    it('falls back to subsequences', () => {
      assert.ok(names(searchNames('isPrSt')).includes('Cubical.Foundations.Prelude.isProp→isSet'))
    })
  })

  describe('about', () => {
    it('needs every name, matching mixfix by parts', () => {
      const hits = names(searchAbout('||_||1 isProp'))
      assert.strictEqual(hits[0], 'Cubical.HITs.PropositionalTruncation.Properties.isPropPropTrunc')
      assert.ok(hits.every(h => h.startsWith('Cubical.HITs.PropositionalTruncation')))
      assert.deepStrictEqual(searchAbout('∥_∥₁ isProp').length, hits.length)
    })

    it('excludes with -name', () => {
      const all = names(searchAbout('||_||1'))
      const without = names(searchAbout('||_||1 -='))
      assert.ok(all.includes('Cubical.HITs.PropositionalTruncation.Properties.propTruncIdempotent'))
      assert.ok(!without.includes('Cubical.HITs.PropositionalTruncation.Properties.propTruncIdempotent'))
    })

    it('ranks types as written above unfolded ones', () => {
      // stdlib's +-comm mentions + only once unfolded
      assert.deepStrictEqual(names(searchAbout('+')), ['Cubical.Data.Nat.Properties.+-comm', 'Data.Nat.Properties.+-comm'])
    })
  })

  describe('types', () => {
    it('matches argument types and results with variables', () => {
      assert.deepStrictEqual(names(searchType('isProp A -> isSet A')), ['Cubical.Foundations.Prelude.isProp→isSet'])
      assert.deepStrictEqual(names(searchType('Iso A B -> A = B')), ['Cubical.Foundations.Isomorphism.isoToPath'])
    })

    it('takes unspaced ascii operators', () => {
      assert.deepStrictEqual(names(searchType('isProp A->isProp B->isProp (A*B)')), ['Cubical.Foundations.HLevels.isProp×'])
      assert.deepStrictEqual(names(searchType('A ~= B -> A == B')), ['Cubical.Foundations.Univalence.ua'])
    })

    it('takes pasted unicode', () => {
      assert.deepStrictEqual(names(searchType('isProp A → ∥ A ∥₁ ≃ A')), ['Cubical.HITs.PropositionalTruncation.Properties.propTruncIdempotent≃'])
    })

    it('reads ||A|| as propositional truncation', () => {
      assert.strictEqual(names(searchType('isProp ||A||'))[0], 'Cubical.HITs.PropositionalTruncation.Properties.isPropPropTrunc')
    })

    it('ignores argument order and dependent binders', () => {
      assert.ok(names(searchType('((x : A) -> isSet (B x)) -> isSet A -> isSet (Sigma A B)')).includes('Cubical.Foundations.HLevels.isSetΣ'))
    })

    it('finds definitions stated through stdlib abstractions', () => {
      const sym = names(searchType('x = y -> y = x'))
      assert.ok(sym.includes('Relation.Binary.PropositionalEquality.Core.sym'))
      assert.ok(sym.includes('Cubical.Foundations.Prelude.sym'))
      assert.ok(sym.includes('Cubical.Foundations.GroupoidLaws._⁻¹'))
      assert.deepStrictEqual(names(searchType('a + b = b + a')).sort(), ['Cubical.Data.Nat.Properties.+-comm', 'Data.Nat.Properties.+-comm'])
    })

    it('binds variables to a name or a bracketed group, not an operator', () => {
      assert.deepStrictEqual(names(searchType('isProp (_ * _)')), ['Cubical.Foundations.HLevels.isProp×'])
    })

    it('ignores brackets around operands', () => {
      assert.ok(names(searchType('(a + b) = (b + a)')).includes('Cubical.Data.Nat.Properties.+-comm'))
    })

    it('matches symmetric results either way round', () => {
      assert.deepStrictEqual(names(searchType('A ~= B -> B = A')), ['Cubical.Foundations.Univalence.ua'])
      assert.strictEqual(searchType('A ~= B -> B = A')[0]!.via, 'symmetry')
      assert.deepStrictEqual(names(searchType('isProp A -> A = ||A||')), ['Cubical.HITs.PropositionalTruncation.Properties.propTruncIdempotent'])
      assert.ok(names(searchType('A = B -> Iso B A')).includes('Cubical.Foundations.Transport.pathToIso'))
    })

    it('matches products against separate arguments', () => {
      const hits = searchType('List A * List A -> List A')
      assert.deepStrictEqual(names(hits).slice(0, 2).sort(), ['Cubical.Data.List.Base._++_', 'Data.List.Base._++_'])
      assert.ok(hits.every(h => h.via === 'currying'))
    })

    it('swaps products', () => {
      const hits = searchType('isProp A -> isProp B -> isProp (B * A)')
      assert.deepStrictEqual(names(hits), ['Cubical.Foundations.HLevels.isProp×'])
    })

    it('only rewrites when exact matches are few', () => {
      const hits = searchType('A -> A')
      assert.ok(hits.length >= 5)
      assert.ok(hits.every(h => h.via === undefined))
    })

    it('keeps brackets around relations', () => {
      assert.deepStrictEqual(names(searchType('isProp A -> (||A|| = A)')), ['Cubical.HITs.PropositionalTruncation.Properties.propTruncIdempotent'])
      assert.deepStrictEqual(names(searchType('_ -> (A ~= B) = (A = B)')), [])
    })

    it('does not let a bare variable result match a concrete query', () => {
      assert.ok(!names(searchType('isProp')).includes('Cubical.HITs.PropositionalTruncation.Properties.rec'))
    })

    it('ranks unfolded matches below types as written', () => {
      assert.strictEqual(names(searchType('x = y -> y = x')).at(-1), 'Relation.Binary.PropositionalEquality.Core.sym')
    })

    it('reads ↔ and unspaced relations', () => {
      assert.deepStrictEqual(names(searchType('A ⊎ B ↔ B ⊎ A')), ['Data.Sum.Properties.swap-↔'])
      assert.deepStrictEqual(names(searchType('A |+| B <-> B |+| A')), ['Data.Sum.Properties.swap-↔'])
      assert.deepStrictEqual(names(searchType('A~=B->A=B')), ['Cubical.Foundations.Univalence.ua'])
    })

    it('takes a pasted name : type line', () => {
      assert.deepStrictEqual(names(searchType('isProp→isSet : {A : Type ℓ} → isProp A → isSet A')), ['Cubical.Foundations.Prelude.isProp→isSet'])
      assert.deepStrictEqual(names(searchType('f : isProp A -> isSet A')), ['Cubical.Foundations.Prelude.isProp→isSet'])
    })

    it('takes ∀ binders and explicit sort binders', () => {
      for (const q of ['∀ {A} → isProp A → isSet A', 'forall A -> isProp A -> isSet A', '(A : Type) -> isProp A -> isSet A', '{A : Type} -> isProp A -> isSet A']) {
        assert.deepStrictEqual(names(searchType(q)), ['Cubical.Foundations.Prelude.isProp→isSet'], q)
      }
      assert.ok(names(searchType('(A B : Type) -> A ~= B -> A = B')).includes('Cubical.Foundations.Univalence.ua'))
    })

    it('keeps operator sections like _≡_ whole', () => {
      assert.deepStrictEqual(names(searchType('Commutative _≡_ _+_')), ['Data.Nat.Properties.+-comm'])
    })

    it('skips irrelevance marks', () => {
      assert.deepStrictEqual(names(searchType('m = n -> Fin m -> Fin n')), ['Data.Fin.Base.cast'])
    })

    it('reads Σ[ x ∈ A ] B and agda\'s Σ-syntax', () => {
      for (const q of ['Iso (S¹ -> A) (Σ[ x ∈ A ] x ≡ x)', 'Iso (S1 -> A) (Sigma A (\\ x -> x = x))']) {
        assert.deepStrictEqual(names(searchType(q)), ['Cubical.HITs.S1.Properties.IsoFunSpaceS¹'], q)
      }
    })

    it('treats types like S¹ as names, not variables', () => {
      assert.ok(!names(searchType('S¹ -> S¹')).includes('Function.Base.id'))
      assert.ok(names(searchType('X -> X')).includes('Function.Base.id'))
    })

    it('treats undefined lowercase words like xs as variables', () => {
      assert.ok(names(searchType('List xs -> List xs -> List xs')).includes('Data.List.Base._++_'))
    })

    it('gives up on long queries quickly', () => {
      const start = performance.now()
      assert.deepStrictEqual(searchType(`||${' '.repeat(2000)}x`), [])
      assert.deepStrictEqual(searchType(`||${' '.repeat(280)}x`), [])
      assert.ok(performance.now() - start < 100)
    })

    it('treats N, Type and ℕ as their builtin names', () => {
      assert.ok(names(searchType('(m n : N) -> m + n = n + m')).includes('Cubical.Data.Nat.Properties.+-comm'))
    })

    it('ranks more general types first', () => {
      const hits = names(searchType('A -> A'))
      assert.ok(hits.indexOf('Function.Base.id') < hits.indexOf('Data.List.Base._++_'))
    })

    it('ranks exact arities above extra arguments', () => {
      const hits = names(searchType('List A -> List A -> List A'))
      assert.deepStrictEqual(hits.slice(0, 3).sort(), ['Cubical.Data.List.Base._++_', 'Data.List.Base._++_', 'Data.List.Base.reverseAcc'])
    })
  })

  describe('display', () => {
    it('drops level binders, renames generated names and says Type for cubical', () => {
      const [isPropIsSet] = lookupName('isProp->isSet')
      assert.strictEqual(isPropIsSet!.entry.type, '{A.ℓ : Level} {A : Set A.ℓ} → isProp A → isSet A')
      assert.strictEqual(displayType(isPropIsSet!.entry.type, 'cubical'), '{A : Type ℓ} → isProp A → isSet A')
      const [sym] = lookupName('Prelude.sym')
      assert.strictEqual(displayType(sym!.entry.type, 'cubical'), '{A : Type ℓ} {x y : A} → x ≡ y → y ≡ x')
    })

    it('keeps record qualifiers that are not binders', () => {
      assert.strictEqual(displayType('{From.a : Level} {From : Set From.a} → Inverse.from From', 'stdlib'), '{From : Set a} → Inverse.from From')
    })

    it('keeps Set for stdlib', () => {
      const [map] = lookupName('Data.List.Base.map')
      assert.strictEqual(displayType(map!.entry.type, 'stdlib'), '{A : Set a} {B : Set b} → (A → B) → List A → List B')
    })

    it('links to the html listing', () => {
      const [hit] = lookupName('isoToPath')
      assert.match(urlFor(hit!), /^https:\/\/agda\.github\.io\/cubical\/Cubical\.Foundations\.Isomorphism\.html#\d+$/)
    })
  })

  describe('loading', () => {
    const file = (library: string, entries: object[]): IndexFile => ({ meta: { library, commit: '', url: '' }, entries } as IndexFile)
    const entry = (name: string, module: string) => ({ name, module, file: module, kind: 'fun', type: 'Set', nf: null, line: 1, pos: 1 })

    it('keeps the old index when a file is malformed', () => {
      assert.throws(() => setIndex([file('x', [entry('a', 'M')]), {} as IndexFile]), /malformed index file/)
      assert.strictEqual(indexSize(), 43)
    })

    it('skips malformed entries', () => {
      setIndex([file('x', [entry('a', 'M'), { ...entry('b', 'M'), type: null }])])
      assert.strictEqual(indexSize(), 1)
    })

    it('links to source lines at the indexed commit, and agda\'s builtins in agda\'s repo', () => {
      const meta = { library: 'cubical', commit: 'abc', url: 'https://agda.github.io/cubical/', source: 'https://github.com/agda/cubical/blob/abc/', agda: '2.9.0' }
      setIndex([{ meta, entries: [{ ...entry('isProp→isSet', 'Cubical.Foundations.Prelude'), file: 'Cubical.Foundations.Prelude', line: 602 }, { ...entry('fst', 'Agda.Builtin.Sigma.Σ'), file: 'Agda.Builtin.Sigma', line: 12 }] }])
      assert.strictEqual(urlFor(lookupName('isProp→isSet')[0]!), 'https://github.com/agda/cubical/blob/abc/Cubical/Foundations/Prelude.agda#L602')
      assert.strictEqual(urlFor(lookupName('fst')[0]!), 'https://github.com/agda/agda/blob/v2.9.0/src/data/lib/prim/Agda/Builtin/Sigma.agda#L12')
    })

    it('ranks instantiated copies after the definitions they come from', () => {
      setIndex([file('x', [{ ...entry('sym', 'Data.List.Relation.Binary.Equality.Propositional._'), copy: true }, entry('sym', 'Relation.Binary.PropositionalEquality.Core')])])
      assert.deepStrictEqual(names(lookupName('sym')), ['Relation.Binary.PropositionalEquality.Core.sym', 'Data.List.Relation.Binary.Equality.Propositional.sym'])
    })

    it('keeps one copy of agda builtins', () => {
      setIndex([file('x', [entry('fst', 'Agda.Builtin.Sigma.Σ')]), file('y', [entry('fst', 'Agda.Builtin.Sigma.Σ'), entry('fst', 'M')])])
      assert.deepStrictEqual(libraries().map(l => [l.name, l.count]), [['x', 1], ['y', 1]])
    })

    after(async () => {
      await loadIndex(FIXTURES)
    })
  })
})
