import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { loadIndex, setIndex } from '../scripts/lib/agdaIndex.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const FIXTURES = 'tests/fixtures/agda-cubical.json,tests/fixtures/agda-stdlib.json.gz'

describe('Agda', () => {
  const state = setupRobot('Agda.ts', { envVars: ['AGDA_INDEX_URLS', 'OWNER_USER_ID'], deferLoad: true })

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
    assert.match(sent[0]!, /^\*\*isProp→isSet\*\* · \[Cubical\.Foundations\.Prelude\]\(<https:\/\/agda\.github\.io\/cubical\/Cubical\.Foundations\.Prelude\.html#\d+>\)/)
    assert.ok(sent[0]!.includes('```agda\nisProp→isSet : {A : Type ℓ} → isProp A → isSet A\n```'))
  })

  it('takes pasted unicode names', async () => {
    const sent = await ask('agda isProp→isSet')
    assert.ok(sent[0]!.startsWith('**isProp→isSet**'))
  })

  it('treats arrows and equations as type searches', async () => {
    const sent = await ask('agda Iso A B -> A = B')
    assert.ok(sent[0]!.startsWith('**isoToPath**'))
    const eq = await ask('agda a + b = b + a')
    assert.match(eq[0]!, /^2 matches for `a \+ b = b \+ a`:/)
  })

  it('falls back to fuzzy name search', async () => {
    const sent = await ask('agda iso path')
    assert.match(sent[0]!, /matches for `iso path`:\n\*\*(isoToPath|pathToIso)\*\*/)
  })

  it('pages with agda more', async () => {
    const first = await ask('agda search s')
    assert.match(first[0]!, /_\d+ more, say `agda more`_$/)
    // header plus five entries
    assert.strictEqual(first[0]!.split('\n**').length, 6)
    const more = await ask('agda more')
    assert.match(more[0]!, /^More for `s`:/)
  })

  it('says when there is nothing more', async () => {
    const sent = await ask('agda more')
    assert.strictEqual(sent[0], 'Nothing more to show.')
  })

  it('searches about names', async () => {
    const sent = await ask('agda about ||_||1 isProp')
    assert.match(sent[0]!, /matches for `\|\|_\|\|1 isProp`:\n\*\*isPropPropTrunc\*\*/)
  })

  it('reports no matches', async () => {
    const sent = await ask('agda type Nonsense A -> A')
    assert.strictEqual(sent[0], 'No matches for `Nonsense A -> A`.')
  })

  it('lists the indexed libraries', async () => {
    const sent = await ask('agda index')
    assert.strictEqual(sent[0], 'cubical: 31 definitions at c37782b\nstdlib: 8 definitions at 1b7f26a')
  })

  it('reports a failed load', async () => {
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
    assert.ok(still[0]!.startsWith('**isProp→isSet**'))
  })

  it('lets only the owner reindex', async () => {
    const denied = await ask('agda reindex')
    assert.strictEqual(denied[0], 'Only my owner can do that.')
    process.env.OWNER_USER_ID = 'boss'
    const ok = await ask('agda reindex', FIXTURES, 'boss')
    assert.strictEqual(ok[0], 'Reloaded 39 definitions.')
  })
})
