import { before, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { ascii, displayType, indexSize, libraries, loadIndex, lookupName, searchAbout, searchNames, searchType, urlFor, type Hit } from '../scripts/lib/agdaIndex.ts'

const FIXTURES = ['tests/fixtures/agda-cubical.json', 'tests/fixtures/agda-stdlib.json.gz']

// module.name of each hit
const names = (hits: Hit[]): string[] => hits.map(h => `${h.entry.module.replace(/\._$/, '')}.${h.entry.name}`)

describe('agda index', () => {
  before(async () => {
    await loadIndex(FIXTURES)
  })

  it('loads plain and gzipped index files', () => {
    assert.deepStrictEqual(libraries().map(l => [l.name, l.count]), [['cubical', 31], ['stdlib', 8]])
    assert.strictEqual(indexSize(), 39)
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
      // stdlib's +-comm only mentions + once Commutative _≡_ _+_ is unfolded
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

    it('does not let a bare variable result match a concrete query', () => {
      assert.ok(!names(searchType('isProp')).includes('Cubical.HITs.PropositionalTruncation.Properties.rec'))
    })

    it('ranks unfolded matches below types as written', () => {
      assert.strictEqual(names(searchType('x = y -> y = x')).at(-1), 'Relation.Binary.PropositionalEquality.Core.sym')
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

    it('keeps Set for stdlib', () => {
      const [map] = lookupName('Data.List.Base.map')
      assert.strictEqual(displayType(map!.entry.type, 'stdlib'), '{A : Set a} {B : Set b} → (A → B) → List A → List B')
    })

    it('links to the html listing', () => {
      const [hit] = lookupName('isoToPath')
      assert.match(urlFor(hit!), /^https:\/\/agda\.github\.io\/cubical\/Cubical\.Foundations\.Isomorphism\.html#\d+$/)
    })
  })
})
