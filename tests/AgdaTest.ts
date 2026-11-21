import { after, before, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { closeStore, loadIndex, wipe } from '../scripts/lib/agda/store.ts'
import { setupRobot, collect, brainUser } from './helpers/setup.ts'
import { noRedis, useTestRedis } from './helpers/redis.ts'

const FIXTURES = 'tests/fixtures/agda-cubical.ndjson,tests/fixtures/agda-stdlib.ndjson'

// one-off index
const tempIndex = async (library: string, entries: object[]): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'agda-'))
  const file = join(dir, `${library}.ndjson`)
  const rows = [{ meta: { library, commit: '', url: 'https://example.org/', source: '', agda: '2.9.0', format: 2 } }, { q: 'M.Big', n: 'Big' }, ...entries]
  await writeFile(file, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  return file
}

describe('Agda', { skip: noRedis }, () => {
  const state = setupRobot(['MessageGuard.ts', 'Agda.ts'], { envVars: ['AGDA_INDEX_URLS', 'OWNER_USER_ID'], deferLoad: true })

  before(async () => {
    useTestRedis('bot')
    await wipe()
  })

  after(async () => {
    await wipe()
    await closeStore()
  })

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
    assert.match(sent[0]!, /^`isProp→isSet` · \[Cubical\.Foundations\.Prelude\]\(<https:\/\/github\.com\/agda\/cubical\/blob\/[0-9a-f]+\/Cubical\/Foundations\/Prelude\.agda#L\d+>\)/)
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
    assert.match(eq[0]!, /^2 matches for `a \+ b = b \+ a`:\n\*\*1\.\*\* `/)
  })

  it('treats patterns with holes as type searches', async () => {
    const sent = await ask('agda sym (p . q) = _ . _')
    assert.ok(sent[0]!.startsWith('`symDistr`'))
    const parts = await ask('agda sym, "distr"')
    assert.ok(parts[0]!.startsWith('`symDistr`'))
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
    assert.match(name[0]!, /^\d definitions named `_\+\+_`:/)
    const type = await ask('agda isProp A -> \\_')
    assert.match(type[0]!, /^\d+ matches for `isProp A -> _`:\n\*\*1\.\*\* `isProp→isSet`/)
  })

  it('survives queries that reduce without end', async () => {
    const sent = await ask('agda (\\ x -> x x) (\\ x -> x x) = (\\ x -> x x) (\\ x -> x x)')
    assert.match(sent[0]!, /^(No matches|\d+ matches|`)/)
    const big = await ask('agda (\\ g x -> g (g (g (g x)))) (\\ g x -> g (g (g (g x)))) (\\ y -> P y y) a = b')
    assert.ok(big[0]!.length > 0)
  })

  it('refuses very long queries', async () => {
    const sent = await ask(`agda ${'A -> '.repeat(80)}A`)
    assert.strictEqual(sent[0], 'That query is too long, keep it under 300 characters.')
  })

  it('falls back to names when a type-like query finds no type', async () => {
    const sent = await ask('agda isProp->isSett')
    assert.match(sent[0]!, /isProp→isSet/)
  })

  it('keeps messages under discord\'s limit', async () => {
    const long = (name: string) => ({ name, module: 'M', file: 'M', kind: 'fun', type: `Big ${'(x : A) → '.repeat(400)}A`, term: ['c', 0], line: 1, pos: 1 })
    const big = await tempIndex('x', [long('big'), ...['b1', 'b2', 'b3', 'b4', 'b5', 'b6'].map(long)])
    await loadIndex([big])
    const one = await ask('agda big', big)
    assert.ok(one[0]!.length <= 1900 && one[0]!.endsWith('```'))
    const many = await ask('agda "b"', big)
    assert.ok(many[0]!.length <= 1900)
    assert.match(many[0]!, /more: `agda more` · `agda 1` shows one in full and why it matched_$/)
  })

  it('falls back to fuzzy name search', async () => {
    await loadIndex(FIXTURES.split(','))
    const sent = await ask('agda iso path')
    assert.match(sent[0]!, /^Closest name: `isoToPath`/)
    const quoted = await ask('agda "iso path"')
    assert.ok(quoted[0]!.startsWith('`isoToPath`'))
  })

  it('pages with agda more', async () => {
    const first = await ask('agda "s"')
    assert.match(first[0]!, /^\d+ names like `s`:/)
    assert.match(first[0]!, /_\d+ more: `agda more` · `agda 1` shows one in full and why it matched_$/)
    // header plus five
    assert.strictEqual(first[0]!.split('\n').length, 12)
    const more = await ask('agda more')
    assert.match(more[0]!, /^More:\n\*\*6\.\*\* `/)
    const one = await ask('agda 6')
    assert.match(one[0]!, /^`[^`]+` · .*\n```agda\n/)
    const none = await ask('agda 999')
    assert.match(none[0]!, /^There's no result 999, the last search found \d+\.$/)
  })

  it('says why a type match matched, as agda shows a goal', async () => {
    await ask('agda a + b = b + a')
    const sent = await ask('agda 1')
    assert.match(sent[0]!, /```\n\*\*Goal\*\* `\(a \+ b\) [≡=] \(b \+ a\)`\n\*\*Have\*\* `[^`]+`/)
    // single matches
    const one = await ask('agda sym (p . q) = sym q . sym p')
    assert.match(one[0]!, /^`symDistr`[\s\S]*```\n\*\*Goal\*\* `sym \(p ∙ q\) [≡=] \(sym q ∙ sym p\)`\n\*\*Have\*\* `sym \(p ∙ q\) [≡=] \(sym q ∙ sym p\)`$/)
    // holes as goals
    for (const q of ['agda sym (p . q) = _ . _', 'agda sym (p . q) = ? . ?']) {
      await ask(q)
      const holes = await ask('agda 1')
      assert.match(holes[0]!, /\*\*Goal\*\* `sym \(p ∙ q\) [≡=] \(\?0 ∙ \?1\)`\n[\s\S]*\n`\?0 := sym q; \?1 := sym p`$/)
    }
    // new goals
    await ask('agda ⊢ isSet A')
    const premise = await ask('agda 1')
    assert.match(premise[0]!, /^`isProp→isSet`[\s\S]*\*\*Have\*\* `isSet A`\n\*\*Give\*\* `isProp→isSet \?0`\n`\?0 : isProp A`$/, premise[0]!)
    // bold part
    await ask('agda sym (p . q)')
    const inside = await ask('agda 1')
    assert.match(inside[0]!, /\*\*Have\*\* `\(p : x [≡=] y\) → \(q : y [≡=] z\) →` \*\*`sym \(p ∙ q\)`\*\* `[≡=] \(sym q ∙ sym p\)`$/, inside[0]!)
    // no explanation for names
    const name = await ask('agda symDistr')
    assert.ok(!name[0]!.includes('**Goal**'))
  })

  it('says when there is nothing more', async () => {
    const sent = await ask('agda more')
    assert.strictEqual(sent[0], 'Nothing to show yet, search first, e.g. `agda isProp A -> isSet A`.')
    const one = await ask('agda 1')
    assert.strictEqual(one[0], 'Nothing to show yet, search first, e.g. `agda isProp A -> isSet A`, then `agda 1`.')
    await ask('agda isProp A -> isSet A')
    const only = await ask('agda more')
    assert.strictEqual(only[0], 'That was the only result.')
  })

  it('searches about names', async () => {
    const sent = await ask('agda ∥_∥₁, isProp')
    assert.match(sent[0]!, /definitions mentioning `∥_∥₁`, `isProp`:\n\*\*1\.\*\* `isPropPropTrunc`/)
    const without = await ask('agda ∥_∥₁, -isProp')
    assert.ok(!without[0]!.includes('`isPropPropTrunc`'))
  })

  it('filters any search', async () => {
    const lib = await ask('agda ++ lib:stdlib')
    assert.ok(lib[0]!.startsWith('`_++_` · [Data.List.Base]'))
    const searched = await ask('agda "iso" kind:record')
    assert.ok(searched[0]!.startsWith('`Iso` · '))
    const listed = await ask('agda in:HLevels kind:fun')
    assert.match(listed[0]!, /^4 definitions in `in:HLevels kind:fun`:\n\*\*1\.\*\* `isSetΣ`/)
    const libs = await ask('agda sym -lib:cubical')
    assert.ok(libs[0]!.startsWith('`sym` · [Relation.Binary.PropositionalEquality.Core]'))
    const unknown = await ask('agda sym lib:nope')
    assert.match(unknown[0]!, /^Unknown library `nope`, try cubical, stdlib/)
    const typed = await ask('agda isProp A -> isSet A in:Data')
    assert.strictEqual(typed[0], "No matches for `isProp A -> isSet A in:Data`. Try fewer details, e.g. holes `?` for parts you don't know, or `⊢` to match only what lemmas prove. More in `agda help`.")
    const bad = await ask('agda sym kind:lemma')
    assert.match(bad[0]!, /^Unknown kind `lemma`/)
  })

  it('shows what a renamed re-export renames', async () => {
    const sent = await ask('agda hcomp')
    assert.match(sent[0]!, /^`hcomp` · \[Cubical\.Core\.Primitives\]\(<[^>]+>\) · = `primHComp`\n/)
  })

  it('reports no matches', async () => {
    const sent = await ask('agda Nonsense A -> A')
    assert.strictEqual(sent[0], 'No matches for `Nonsense A -> A`. `Nonsense` isn\'t a name I know; `agda "Nonsense"` searches for similar ones. More in `agda help`.')
    const broken = await ask('agda sym (p . q')
    assert.match(broken[0]!, /I couldn't read it, check the brackets/)
  })

  it('lists the indexed libraries', async () => {
    const sent = await ask('agda libs')
    assert.match(sent[0]!, /^\*\*cubical\*\* · 39 definitions at \[[0-9a-f]{7}\]\(<[^>]+>\)\n\*\*stdlib\*\* · 23 definitions at \[[0-9a-f]{7}\]\(<[^>]+>\)\n_checked with Agda 2\.9\.0_$/)
  })

  it('explains the syntax', async () => {
    for (const q of ['agda', 'agda help']) {
      const sent = await ask(q)
      assert.match(sent[0]!, /^\*\*Agda search\*\* over cubical, stdlib\./)
      assert.ok(sent[0]!.includes('`agda sym (p . q) = ? . ?`'))
      assert.ok(sent[0]!.includes('`agda help examples`'))
    }
    // topics and examples
    const types = await ask('agda help types')
    assert.match(types[0]!, /^\*\*Searching by type\.\*\*[\s\S]*`agda Iso A B -> A = B` → `isoToPath`/)
    for (const t of ['patterns', 'filters', 'examples']) assert.ok((await ask(`agda help ${t}`))[0]!.startsWith('**'))
    const wrong = await ask('agda help nope')
    assert.match(wrong[0]!, /^There's no help on `nope`, try `agda help types`/)
  })

  it('reports a failed load', async () => {
    // let loads settle
    await new Promise(resolve => setTimeout(resolve, 50))
    await wipe()
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
    assert.strictEqual(ok[0], 'Reloaded 62 definitions.')
  })
})
