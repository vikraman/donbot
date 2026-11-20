import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { loadIndex, setIndex, type IndexFile } from '../scripts/lib/agdaIndex.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const FIXTURES = 'tests/fixtures/agda-cubical.json,tests/fixtures/agda-stdlib.json'

describe('Agda', () => {
  const state = setupRobot(['MessageGuard.ts', 'Agda.ts'], { envVars: ['AGDA_INDEX_URLS', 'OWNER_USER_ID'], deferLoad: true })

  const loaded = new WeakSet<object>()

  const ask = async (text: string, sources = FIXTURES, user = 'test-user') => {
    process.env.AGDA_INDEX_URLS = sources
    if (!loaded.has(state.robot)) {
      loaded.add(state.robot)
      await state.loadScript()
    }
    const sent = collect(state.robot)
    await state.robot.adapter.say(brainUser(state.robot, user, user), `@Dumbotheelephant ${text}`, 'test-room')
    return sent
  }

  it('shows a single definition with its type and link', async () => {
    const sent = await ask('agda isProp->isSet')
    assert.strictEqual(sent.length, 1)
    assert.match(sent[0]!, /^`isProp→isSet` · \[Cubical\.Foundations\.Prelude\]\(<https:\/\/agda\.github\.io\/cubical\/Cubical\.Foundations\.Prelude\.html#\d+>\)/)
    assert.ok(sent[0]!.includes('```agda\nisProp→isSet : {A : Type ℓ} → isProp A → isSet A\n```'))
  })

  it('takes pasted unicode names', async () => {
    const sent = await ask('agda isProp→isSet')
    assert.ok(sent[0]!.startsWith('`isProp→isSet`'))
  })

  it('treats arrows and equations as type searches', async () => {
    const sent = await ask('agda Iso A B -> A = B')
    assert.ok(sent[0]!.startsWith('`isoToPath`'))
    const eq = await ask('agda a + b = b + a')
    assert.match(eq[0]!, /^2 matches for `a \+ b = b \+ a`:/)
  })

  it('marks matches that needed a rewrite', async () => {
    const sent = await ask('agda A ~= B -> B = A')
    assert.match(sent[0]!, /^`ua` · \[Cubical\.Foundations\.Univalence\]\(<[^>]+>\) · up to symmetry\n/)
  })

  it('takes queries over several lines', async () => {
    const sent = await ask('agda isProp A\n  -> isSet A')
    assert.ok(sent[0]!.startsWith('`isProp→isSet`'))
  })

  it('drops markdown escapes from discord clients', async () => {
    const name = await ask('agda \\_++\\_')
    assert.match(name[0]!, /^2 matches for `_\+\+_`:/)
    const type = await ask('agda isProp A -> \\_')
    assert.match(type[0]!, /^\d+ matches for `isProp A -> _`:\n`isProp→isSet`/)
  })

  it('refuses very long queries', async () => {
    const sent = await ask(`agda type ${'A -> '.repeat(80)}A`)
    assert.strictEqual(sent[0], 'That query is too long, keep it under 300 characters.')
  })

  it('falls back to names when a type-like query finds no type', async () => {
    const sent = await ask('agda isProp->isSett')
    assert.match(sent[0]!, /isProp→isSet/)
  })

  it('keeps messages under discord\'s limit', async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    const long = (name: string) => ({ name, module: 'M', file: 'M', kind: 'fun', type: `Big ${'(x : A) → '.repeat(400)}A`, nf: null, line: 1, pos: 1 })
    setIndex([{ meta: { library: 'x', commit: '', url: 'https://example.org/' }, entries: [long('big'), ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map(long)] } as IndexFile])
    const one = await ask('agda big')
    assert.ok(one[0]!.length <= 1900 && one[0]!.endsWith('```'))
    const many = await ask('agda search b')
    assert.ok(many[0]!.length <= 1900)
    assert.match(many[0]!, /more, say `agda more`_$/)
    await loadIndex(FIXTURES.split(','))
  })

  it('falls back to fuzzy name search', async () => {
    const sent = await ask('agda iso path')
    assert.match(sent[0]!, /matches for `iso path`:\n`(isoToPath|pathToIso)`/)
  })

  it('pages with agda more', async () => {
    const first = await ask('agda search s')
    assert.match(first[0]!, /_\d+ more, say `agda more`_$/)
    // header plus five names and their types
    assert.strictEqual(first[0]!.split('\n`').length, 11)
    const more = await ask('agda more')
    assert.match(more[0]!, /^More for `s`:/)
  })

  it('says when there is nothing more', async () => {
    const sent = await ask('agda more')
    assert.strictEqual(sent[0], 'Nothing more to show.')
  })

  it('searches about names', async () => {
    const sent = await ask('agda about ||_||1 isProp')
    assert.match(sent[0]!, /matches for `\|\|_\|\|1 isProp`:\n`isPropPropTrunc`/)
  })

  it('filters any search', async () => {
    const lib = await ask('agda ++ lib:stdlib')
    assert.ok(lib[0]!.startsWith('`_++_` · [Data.List.Base]'))
    const searched = await ask('agda search iso kind:record')
    assert.ok(searched[0]!.startsWith('`Iso` · '))
    const listed = await ask('agda in:HLevels kind:fun')
    assert.match(listed[0]!, /^4 matches for `in:HLevels kind:fun`:\n`isSetΣ`/)
    const typed = await ask('agda type isProp A -> isSet A in:Data')
    assert.strictEqual(typed[0], 'No matches for `isProp A -> isSet A in:Data`.')
    const bad = await ask('agda sym kind:lemma')
    assert.match(bad[0]!, /^Unknown kind `lemma`/)
  })

  it('shows what a renamed re-export renames', async () => {
    await new Promise(resolve => setTimeout(resolve, 50))
    setIndex([{ meta: { library: 'cubical', commit: '', url: 'https://example.org/' }, entries: [{ name: 'hcomp', module: 'Cubical.Core.Primitives', file: 'Cubical.Core.Primitives', kind: 'prim', type: 'I → I', nf: null, line: 0, pos: 0, alias: 'Agda.Primitive.Cubical.primHComp' }] } as IndexFile])
    const sent = await ask('agda hcomp')
    assert.match(sent[0]!, /^`hcomp` · \[Cubical\.Core\.Primitives\]\(<[^>]+>\) · = `primHComp`\n/)
    await loadIndex(FIXTURES.split(','))
  })

  it('reports no matches', async () => {
    const sent = await ask('agda type Nonsense A -> A')
    assert.strictEqual(sent[0], 'No matches for `Nonsense A -> A`.')
  })

  it('lists the indexed libraries', async () => {
    const sent = await ask('agda index')
    assert.strictEqual(sent[0], 'cubical: 33 definitions at c37782b\nstdlib: 10 definitions at 1b7f26a')
  })

  it('reports a failed load', async () => {
    // let earlier robots' loads settle
    await new Promise(resolve => setTimeout(resolve, 50))
    setIndex([])
    const sent = await ask('agda isSet', 'tests/fixtures/missing.json')
    assert.match(sent[0]!, /^The Agda index failed to load: .*missing\.json/)
  })

  it('keeps serving the old index when a reload fails', async () => {
    await loadIndex(FIXTURES.split(','))
    process.env.OWNER_USER_ID = 'boss'
    const sent = await ask('agda reindex', 'tests/fixtures/missing.json', 'boss')
    assert.match(sent[0]!, /^Reindex failed: .*missing\.json/)
    const still = await ask('agda isProp->isSet', 'tests/fixtures/missing.json')
    assert.ok(still[0]!.startsWith('`isProp→isSet`'))
  })

  it('lets only the owner reindex', async () => {
    const denied = await ask('agda reindex')
    assert.strictEqual(denied[0], 'Only my owner can do that.')
    process.env.OWNER_USER_ID = 'boss'
    const ok = await ask('agda reindex', FIXTURES, 'boss')
    assert.strictEqual(ok[0], 'Reloaded 43 definitions.')
  })
})
