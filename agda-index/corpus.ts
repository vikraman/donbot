// corpus runner: node agda-index/corpus.ts [corpus.txt] [--show n] [--load index.ndjson.gz...]
import { readFileSync } from 'node:fs'

import { closeStore, loadIndex, refresh, wipe } from '../scripts/lib/agda/store.ts'
import { searchType, splitFilters } from '../scripts/lib/agda/search.ts'

const TOP = 3

export interface Case {
  query: string
  expect: string[]
  // known miss
  known: boolean
  // excluded names
  never: string[]
}

export const readCorpus = (file: string): Case[] =>
  readFileSync(file, 'utf8').split('\n').filter(l => l.trim() && !l.startsWith('#')).map(l => {
    const [rest, never] = l.split(' #! ')
    const [query, mark, expect] = rest!.split(/ (#[>?]) /)
    return { query: query!.trim(), expect: expect ? expect.trim().split(/\s+/) : [], known: mark === '#?', never: never ? never.trim().split(/\s+/) : [] }
  })

const main = async () => {
  const args = process.argv.slice(2)
  const at = args.indexOf('--show')
  const show = at >= 0 ? Number(args.splice(at, 2)[1]) : 0
  // indexes to load
  const from = args.indexOf('--load')
  const load = from >= 0 ? args.splice(from).slice(1) : []
  const file = args[0] ?? new URL('corpus.txt', import.meta.url).pathname
  if (load.length > 0) {
    const { loaded, skipped } = await loadIndex(load, true)
    console.log(`loaded ${loaded.join(', ')}${skipped.length > 0 ? `, skipped ${skipped.join('; ')}` : ''}\n`)
  }
  await refresh()
  let failed = 0
  let known = 0
  let slow = 0
  for (const { query, expect, known: miss, never } of readCorpus(file)) {
    const { query: q, filter } = splitFilters(query)
    const t = performance.now()
    const hits = await searchType(q, filter)
    const ms = Math.round(performance.now() - t)
    if (ms > 300) slow++
    const top = hits.slice(0, TOP).map(h => h.entry.name)
    const bad = top.filter(n => never.includes(n))
    const ok = (expect.length === 0 || top.some(n => expect.includes(n))) && bad.length === 0
    if (!ok && miss && bad.length === 0) known++
    else if (!ok) failed++
    const why = bad.length > 0 ? `  should not find ${bad.join(' ')}` : `  wanted ${expect.join(' ')}, got ${top.join(' ') || 'nothing'}`
    console.log(`${ok ? (expect.length === 0 && never.length === 0 ? '·' : '✓') : miss && bad.length === 0 ? '?' : '✗'} ${query}  [${hits.length}, ${ms}ms]${ok ? '' : why}`)
    for (const h of hits.slice(0, show)) console.log(`    ${h.lib.name} ${h.entry.name}${h.via ? ` ~${h.via}` : ''} : ${h.entry.type.slice(0, 120)}`)
  }
  console.log(`\n${failed} failed, ${known} known misses, ${slow} over 300ms`)
  // cleanup
  if (load.length > 0) await wipe()
  await closeStore()
  process.exitCode = failed > 0 ? 1 : 0
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
