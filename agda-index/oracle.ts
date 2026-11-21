// agda check of top hits: node agda-index/oracle.ts [--top n] [--only text] lib=path/to/lib.agda-lib...
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'

import { readCorpus } from './corpus.ts'
import { hash, plainModule } from '../scripts/lib/agda/fold.ts'
import { closeStore, refresh } from '../scripts/lib/agda/store.ts'
import { searchType, splitFilters, zonk, type Hit, type Match } from '../scripts/lib/agda/search.ts'
import { consts, type Term } from '../scripts/lib/agda/term.ts'
import { resolve as resolveMeta } from '../scripts/lib/agda/unify.ts'

const HERE = dirname(new URL(import.meta.url).pathname)
const OUT = join(HERE, 'build', 'oracle')
const TIMEOUT_MS = 120_000

export type Verdict = 'ok' | 'unsound' | 'stuck' | 'skip' | 'timeout'

// library as agda sees it
interface Lib {
  name: string
  agdaLib: string
  libName: string
  flags: string[]
  include: string[]
  qOf: Map<string, string>
  npOf: Map<string, number>
  // use counts
  refs: Map<string, number>
  // private names
  hidden: Set<string>
  // binders per definition
  binders: Map<string, { written: Binder[], unfolded: Binder[] }>
}

interface Binder {
  hiding: number
  named: boolean
  level: boolean
}

const AGDA = process.env.AGDA ?? 'agda'
const PRIM = join(execFileSync(AGDA, ['--print-agda-data-dir']).toString().trim(), 'lib', 'prim')

const agdaLibField = (text: string, field: string): string[] => {
  const m = new RegExp(`^${field}:([^\\n]*(?:\\n[ \\t]+[^\\n]*)*)`, 'm').exec(text)
  return m ? m[1]!.split(/\s+/).filter(Boolean) : []
}

// ndjson rows: names and entries
interface Row { q?: string, np?: number, same?: string, name?: string, module?: string, term?: unknown, unf?: unknown }

const loadLib = (name: string, agdaLib: string, index: string): Lib => {
  const text = readFileSync(agdaLib, 'utf8')
  const rows = gunzipSync(readFileSync(index)).toString().split('\n').filter(Boolean).map(l => JSON.parse(l) as Row)
  const names = rows.filter((r): r is Row & { q: string } => typeof r.q === 'string')
  const byQ = new Map(names.map(r => [r.q, r]))
  // ids hash alias chain end
  const canon = (q: string): string | null => {
    for (let i = 0; i < 10; i++) {
      const t = byQ.get(q)
      if (!t?.same) return q
      if (t.same === 'sort') return null
      q = t.same
    }
    return q
  }
  const qOf = new Map<string, string>()
  const npOf = new Map<string, number>()
  for (const r of names) {
    const c = canon(r.q)
    if (!c) continue
    const id = hash(c)
    if (!qOf.has(id) || c === r.q) qOf.set(id, c)
    if (c === r.q) npOf.set(id, r.np ?? 0)
  }
  const refs = new Map<string, number>()
  const ids = names.map(r => {
    const c = canon(r.q)
    return c ? hash(c) : null
  })
  const visit = (t: unknown) => {
    if (!Array.isArray(t)) return
    if (t[0] === 'c' && typeof t[1] === 'number' && ids[t[1]]) refs.set(ids[t[1]]!, (refs.get(ids[t[1]]!) ?? 0) + 1)
    t.forEach(visit)
  }
  for (const r of rows) if (typeof r.name === 'string') visit(r.term)
  const level = (t: unknown) => Array.isArray(t) && t[0] === 'c' && names[t[1] as number]?.q === 'Agda.Primitive.Level'
  const telescope = (t: unknown): Binder[] => {
    const out: Binder[] = []
    while (Array.isArray(t) && t[0] === 'p') {
      out.push({ hiding: t[1] as number, named: typeof t[2] === 'number', level: level(t[3]) })
      t = t[4]
    }
    return out
  }
  const binders = new Map<string, { written: Binder[], unfolded: Binder[] }>()
  for (const r of rows) if (typeof r.name === 'string') binders.set(`${r.module}.${r.name}`, { written: telescope(r.term), unfolded: telescope(r.unf ?? r.term) })
  const dir = dirname(agdaLib)
  return { name, agdaLib, libName: agdaLibField(text, 'name')[0]!, flags: agdaLibField(text, 'flags'), include: [...agdaLibField(text, 'include').map(i => resolve(dir, i)), PRIM], qOf, npOf, refs, hidden: new Set(), binders }
}

// longest module prefix
const fileOf = (lib: Lib, q: string, cache: Map<string, string | null>): string | null => {
  const segs = plainModule(q).split('.')
  for (let k = segs.length - 1; k > 0; k--) {
    const m = segs.slice(0, k).join('.')
    let hit = cache.get(m)
    if (hit === undefined) {
      const path = m.replace(/\./g, '/')
      hit = lib.include.some(d => ['.agda', '.lagda', '.lagda.md', '.lagda.tex', '.lagda.org'].some(e => existsSync(join(d, path + e)))) ? m : null
      cache.set(m, hit)
    }
    if (hit) return hit
  }
  return null
}

class Unprintable extends Error {}
// ill-scoped claim
class Escape extends Error {}

// claim as agda module
export const render = (lib: Lib, h: Hit, m: Match, modName: string, files: Map<string, string | null>): string => {
  const s = m.subst
  const imports = new Set<string>()
  const prefer = new Set(consts({ args: m.cand.args, res: m.cand.res }))
  const qualified = (id: string): [string, number] => {
    const q = lib.qOf.get(id)
    if (!q) throw new Unprintable(`no name for ${id}`)
    const file = fileOf(lib, q, files)
    if (!file) throw new Unprintable(`no module for ${q}`)
    imports.add(file)
    return [plainModule(q), lib.npOf.get(id) ?? 0]
  }
  const z = (t: Term) => zonk(t, s)
  // current meta of a variable
  const repOf = (meta: string): string | null => {
    const r = resolveMeta(meta, s)
    return !r ? meta : r.k === 'm' && r.a.length === 0 ? r.m : null
  }
  // generalise free variables
  const xs = m.query.args.map((_, i) => `x${i}`)
  const binderOf = new Map<string, number>()
  m.binders?.forEach((b, i) => {
    const r = b && repOf(b)
    if (r) binderOf.set(r, i)
  })
  m.args.forEach((k, i) => {
    const v = m.cand.argVars?.[k]
    const r = v != null ? repOf(`c${v}`) : null
    if (r && !binderOf.has(r)) binderOf.set(r, i)
  })
  const vars = new Map<string, string>()
  let frozen = false
  // binders in scope
  let scope = xs.length
  const paren = (x: string) => (/\s/.test(x) && !/^[({⦃].*[)}⦄]$/.test(x) ? `(${x})` : x)
  const app = (f: string, as: string[]) => (as.length === 0 ? f : `${f} ${as.map(paren).join(' ')}`)
  const print = (t: Term, env: string[]): string => {
    switch (t.k) {
      case 'm': {
        const as = t.a.map(a => print(a, env))
        if (t.m.startsWith('h')) return as.length === 0 ? '_' : app('_', as)
        const i = binderOf.get(t.m)
        if (i !== undefined) {
          if (i >= scope) throw new Escape(`x${i} used before it is bound`)
          return app(xs[i]!, as)
        }
        let v = vars.get(t.m)
        if (!v) {
          if (frozen) return as.length === 0 ? '_' : app('_', as)
          vars.set(t.m, (v = `v${vars.size}`))
        }
        return app(v, as)
      }
      case 'b': return app(env[env.length - 1 - t.i] ?? '_', t.a.map(a => print(a, env)))
      case 'c': {
        const ids = typeof t.id === 'string' ? [t.id] : [...t.id]
        if (ids.some(i => i.startsWith('#'))) throw new Unprintable('rigid constant')
        const known = ids.filter(i => lib.qOf.has(i)).sort((a, b) => (lib.refs.get(b) ?? 0) - (lib.refs.get(a) ?? 0))
        const id = known.find(i => prefer.has(i)) ?? known[0]
        if (!id) throw new Unprintable(`no name for ${ids.join('|')}`)
        // private names as wildcards
        if (lib.hidden.has(plainModule(lib.qOf.get(id)!))) return t.a.length === 0 ? '_' : app('_', t.a.map(a => print(a, env)))
        const [q, np] = qualified(id)
        const as = t.a.map(a => print(a, env))
        // restore levels and params
        const tele = lib.binders.get(lib.qOf.get(id)!)?.written.filter(b => b.hiding === 0)
        if (!tele) return app(q, [...Array<string>(np).fill('_'), ...as])
        const out: string[] = []
        let last = np
        for (let i = 0; i < tele.length; i++) {
          if (i < np || tele[i]!.level) out.push('_')
          else if (as.length > 0) {
            out.push(as.shift()!)
            last = out.length
          } else break
        }
        // trailing levels
        const full = tele.slice(out.length).every(b => b.level)
        return app(q, [...(full ? [...out, ...tele.slice(out.length).map(() => '_')] : out.slice(0, Math.max(last, np))), ...as])
      }
      case 'p': {
        const x = `b${env.length}`
        return `(${x} : ${print(t.d, env)}) → ${print(t.c, [...env, x])}`
      }
      case 'l': {
        const x = `b${env.length}`
        return `(λ ${x} → ${print(t.b, [...env, x])})`
      }
      case 'n': return t.v
      case 's': case 'w': return '_'
    }
  }
  const res = print(z(m.query.res), [])
  const args = m.query.args.map((a, i) => {
    scope = i
    return print(z(a), [])
  })
  scope = 0
  // typed as candidate telescope
  const types = new Map<string, string>()
  const deps = new Map<string, Set<string>>()
  for (let done = 0; done < vars.size;) {
    const [meta] = [...vars.keys()].slice(done, done + 1)
    done++
    const k = /^c(\d+)$/.exec(meta!)?.[1]
    const t = k !== undefined ? m.cand.types?.[Number(k)] : undefined
    const before = new Set(vars.keys())
    const text = t ? print(z(t), []) : '_'
    types.set(meta!, text)
    deps.set(meta!, new Set([...vars.keys()].filter(v => v !== meta && (!before.has(v) || new RegExp(`(^|[\\s(])${vars.get(v)}($|[\\s)])`).test(text)))))
  }
  // dependency order
  const order: string[] = []
  const left = new Set(vars.keys())
  while (left.size > 0) {
    const free = [...left].filter(v => ![...left].some(w => deps.get(w)?.has(v)))
    if (free.length === 0) throw new Unprintable('cyclic variable types')
    const last = free.find(v => types.get(v) === '_') ?? free[0]!
    order.unshift(last)
    left.delete(last)
  }
  frozen = true
  scope = xs.length
  // candidate binders
  const id = headId(lib, h)
  const [head] = qualified(id)
  const tele = lib.binders.get(`${h.entry.module}.${h.entry.name}`)
  if (!tele) throw new Unprintable('no telescope')
  const value = (v: number | null): string => {
    if (v === null) return '_'
    const r = repOf(`c${v}`)
    if (r === `c${v}` && !binderOf.has(r) && !vars.has(r)) return '_'
    return print(z({ k: 'm', m: `c${v}`, a: [] }), [])
  }
  const es: string[] = []
  let k = 0
  let e = 0
  for (const b of m.unfolded ? tele.unfolded : tele.written) {
    const v = b.named ? k++ : null
    if (b.hiding === 0) {
      if (b.level) {
        es.push('_')
        continue
      }
      const i = m.args.indexOf(e++)
      es.push(i >= 0 ? xs[i]! : value(v))
    } else if (b.hiding === 1) es.push(`{${b.level ? '_' : value(v)}}`)
    else es.push('⦃ ? ⦄')
  }
  // quantify in dependency order
  const lams = [...order.map(v => `{${vars.get(v)}}`), ...xs]
  const body = lams.length > 0 ? `λ ${lams.join(' ')} → ${app(head, es)}` : app(head, es)
  const type = [...order].reduceRight((c, v) => `{${vars.get(v)} : ${types.get(v)}} → ${c}`, args.reduceRight((c, d, i) => `(${xs[i]} : ${d}) → ${c}`, res))
  return [
    `module ${modName} where`,
    `-- ${h.entry.name} for the matcher's claim`,
    'import Agda.Primitive',
    ...[...imports].sort().map(i => `import ${i}`),
    '',
    '-- one term, so the type\'s metas are solved with the body\'s',
    'the : ∀ {a} (A : Agda.Primitive.Set a) → A → A',
    'the _ x = x',
    '',
    `_ = the (${type})`,
    `  (${body})`,
    ''
  ].join('\n')
}

// hit's own id
const headId = (lib: Lib, h: Hit): string => {
  const q = `${h.entry.module}.${h.entry.name}`
  const id = hash(q)
  if (lib.qOf.has(id)) return id
  // copies under own names
  for (const [i, n] of lib.qOf) if (n === q) return i
  throw new Unprintable(`no name for ${q}`)
}

// agda process per library
class Agda {
  private proc: ChildProcessWithoutNullStreams | null = null
  private buf = ''
  private waiter: (() => void) | null = null
  private dir: string
  private libraries: string
  constructor (dir: string, libraries: string) {
    this.dir = dir
    this.libraries = libraries
  }

  private start () {
    this.proc = spawn(AGDA, ['--interaction-json', `--library-file=${this.libraries}`], { cwd: this.dir })
    this.buf = ''
    this.proc.stdout.on('data', (d: Buffer) => {
      this.buf += d.toString()
      this.waiter?.()
    })
    this.proc.stderr.on('data', () => {})
  }

  private prompts () {
    return this.buf.split('JSON> ').length - 1
  }

  async load (file: string): Promise<{ verdict: Verdict, why: string }> {
    if (!this.proc) this.start()
    // skip first prompt
    const before = Math.max(this.prompts(), 1)
    const from = this.buf.length
    this.proc!.stdin.write(`IOTCM "${file}" None Indirect (Cmd_load "${file}" [])\n`)
    const done = await new Promise<boolean>(res => {
      const timer = setTimeout(() => res(false), TIMEOUT_MS)
      this.waiter = () => {
        if (this.prompts() > before) {
          clearTimeout(timer)
          res(true)
        }
      }
      this.waiter()
    })
    this.waiter = null
    if (!done) {
      this.proc!.kill()
      this.proc = null
      return { verdict: 'timeout', why: `over ${TIMEOUT_MS / 1000}s` }
    }
    const infos = this.buf.slice(from).split('\n').filter(l => l.includes('"DisplayInfo"')).map(l => {
      try {
        return (JSON.parse(l.replace(/^JSON> /, '')) as { info?: Info }).info ?? null
      } catch {
        return null
      }
    }).filter((i): i is Info => i !== null)
    return classify(infos)
  }

  close () {
    this.proc?.kill()
  }
}

// verdict from errors
// missing instances as premises
const SKIP = /Setω|InstanceNoCandidate|GeneralizationPrepruneErrorCyclicDependencies|NotInScope|FileNotFound|AmbiguousName|AmbiguousModule|ModuleDoesntExport|NoSuchModule|Parse error|parse error|InvalidPattern|ModuleNameDoesntMatchFileName|AmbiguousTopLevelModuleName|CantGeneralize|GeneralizeCyclicDependency|NotAValidLetBinding|UnusedVariableInPatternSynonym|MissingTypeSignature/
// agda's DisplayInfo
interface Info { kind: string, error?: { message: string }, errors?: { message: string }[] }

export const classify = (infos: Info[]): { verdict: Verdict, why: string } => {
  const err = infos.find(i => i.kind === 'Error')
  if (err) {
    const msg = err.error?.message ?? ''
    const why = msg.split('\n').find(l => /error:/.test(l))?.replace(/^.*error: /, '') ?? msg.slice(0, 80)
    return { verdict: SKIP.test(msg) ? 'skip' : 'unsound', why: msg.includes('\n') ? `${why} ${msg.split('\n').slice(1, 4).join(' ').replace(/\s+/g, ' ').slice(0, 200)}` : why }
  }
  const goals = infos.find(i => i.kind === 'AllGoalsWarnings')
  const stuck = goals?.errors?.find(e => /UnsolvedConstraints/.test(e.message))
  if (stuck) return { verdict: 'stuck', why: stuck.message.split('\n').slice(1, 4).join(' ').replace(/\s+/g, ' ').slice(0, 200) }
  return { verdict: 'ok', why: '' }
}

const main = async () => {
  const args = process.argv.slice(2)
  const opt = (flag: string, dflt: string) => {
    const at = args.indexOf(flag)
    return at >= 0 ? args.splice(at, 2)[1]! : dflt
  }
  const top = Number(opt('--top', '3'))
  const only = opt('--only', '')
  const corpus = opt('--corpus', join(HERE, 'corpus.txt'))
  const libs = new Map(args.filter(a => a.includes('=')).map(a => {
    const [name, path] = a.split('=') as [string, string]
    return [name, loadLib(name, resolve(path.replace(/^~/, process.env.HOME!)), join(HERE, 'build', 'index', `${name}.ndjson.gz`))]
  }))
  if (libs.size === 0) throw new Error('usage: oracle.ts lib=path/to/lib.agda-lib...')
  mkdirSync(OUT, { recursive: true })
  const libraries = join(OUT, 'libraries')
  writeFileSync(libraries, [...libs.values()].map(l => l.agdaLib).join('\n') + '\n')
  const agdas = new Map<string, Agda>()
  const files = new Map<string, Map<string, string | null>>()
  for (const l of libs.values()) {
    const dir = join(OUT, l.name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `oracle-${l.name}.agda-lib`), `name: oracle-${l.name}\ninclude: .\ndepend: ${l.libName}\nflags: ${l.flags.join(' ')}\n`)
    agdas.set(l.name, new Agda(dir, libraries))
    files.set(l.name, new Map())
  }
  await refresh()
  const tally: Record<Verdict, number> = { ok: 0, unsound: 0, stuck: 0, skip: 0, timeout: 0 }
  let n = 0
  for (const { query } of readCorpus(corpus)) {
    if (only && !query.includes(only)) continue
    const { query: q, filter } = splitFilters(query)
    const hits = (await searchType(q, filter)).slice(0, top)
    console.log(`\n## ${query}`)
    for (const h of hits) {
      const lib = libs.get(h.lib.name)
      const label = `${h.lib.name} ${h.entry.name}${h.via ? ` ~${h.via}` : ''}`
      let verdict: Verdict = 'skip'
      let why = ''
      if (!lib) why = 'library not configured'
      else if (!h.match || h.match.mode === 'anywhere') why = 'matched inside a type'
      else if (h.match.query.args.length > 0 && !h.match.binders) why = 'rewritten arguments'
      else {
        const mod = `C${n++}`
        try {
          // retry without private names
          for (let tries = 0; tries < 4; tries++) {
            writeFileSync(join(OUT, lib.name, `${mod}.agda`), render(lib, h, h.match, mod, files.get(lib.name)!))
            ;({ verdict, why } = await agdas.get(lib.name)!.load(`${mod}.agda`))
            const missing = verdict === 'skip' ? /\[NotInScope\] Not in scope: (\S+)/.exec(why)?.[1] : undefined
            if (!missing || lib.hidden.has(missing)) break
            lib.hidden.add(missing)
          }
          if (verdict !== 'ok') why = `${why} [${lib.name}/${mod}.agda]`
        } catch (e) {
          if (e instanceof Escape) verdict = 'unsound'
          else if (!(e instanceof Unprintable)) throw e
          why = e.message
        }
      }
      tally[verdict]++
      console.log(`  ${verdict.padEnd(7)} ${label}${why ? `  ${why}` : ''}`)
    }
  }
  console.log(`\n${Object.entries(tally).map(([k, v]) => `${v} ${k}`).join(', ')}`)
  for (const a of agdas.values()) a.close()
  await closeStore()
}

if (import.meta.url === `file://${process.argv[1]}`) await main()
