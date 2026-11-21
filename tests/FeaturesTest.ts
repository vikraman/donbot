import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync } from 'node:fs'

import { setupRobot } from './helpers/setup.ts'
import { mockFetch, settle } from './helpers/fakes.ts'

import { chainFor, EXTERNAL, features, listenerId } from '../scripts/lib/features.ts'
import { featureOfHelp, helpPrefixes } from '../scripts/lib/help.ts'

const SCRIPTS = readdirSync('./scripts').filter(f => f.endsWith('.ts')).sort()

interface ListenerLike {
  options?: { id?: string | null }
  regex?: RegExp
}

// all scripts, like production
describe('feature coverage', () => {
  const state = setupRobot(SCRIPTS, { deferLoad: true, envVars: ['AGDA_INDEX_URLS'] })

  const load = async () => {
    process.env.AGDA_INDEX_URLS = 'http://127.0.0.1:9/none.json.gz'
    mockFetch('', { ok: false, status: 404 })
    await state.loadScript()
    const before = state.robot.listeners!.length
    await state.robot.loadExternalScripts(['hubot-rules', 'hubot-diagnostics'])
    // loadFile isn't awaited
    while (state.robot.listeners!.length < before + 5) await settle()
    return state.robot.listeners as unknown as ListenerLike[]
  }

  it('maps every listener to a registered feature', async () => {
    const listeners = await load()
    const missing = listeners
      .map(l => ({ id: listenerId(l), source: l.regex?.source }))
      .filter(({ id }) => !id || chainFor(id).length === 0)
    assert.deepStrictEqual(missing, [])
  })

  it('matches each external pattern to exactly one listener', async () => {
    const listeners = await load()
    for (const [tail] of EXTERNAL) {
      const hits = listeners.filter(l => l.regex?.source.endsWith(`(?:${tail})`))
      assert.strictEqual(hits.length, 1, tail)
    }
  })

  it('maps every help line to a feature', async () => {
    await load()
    const prefixes = helpPrefixes()
    const orphans = state.robot.helpCommands().filter(line => !featureOfHelp(prefixes, line))
    assert.deepStrictEqual(orphans, [])
  })

  it('leaves the command bus empty, since it would skip the gate', async () => {
    await load()
    const commands = (state.robot as unknown as { commands: { listCommands: () => unknown[] } }).commands.listCommands()
    assert.deepStrictEqual(commands, [])
  })

  it('rates every feature and keeps ids unique', async () => {
    await load()
    const all = features()
    assert.strictEqual(new Set(all.map(f => f.id)).size, all.length)
    for (const f of all) {
      assert.ok(['professional', 'casual', 'mature'].includes(f.level), f.id)
      assert.ok(f.label, f.id)
      // web features never passive or mature
      if (f.web) assert.ok(f.level === 'professional' && !f.passive, f.id)
      if (f.passive) assert.ok(f.stores, `${f.id} says what it stores`)
    }
  })
})
