// fixture cutter: node tests/fixtures/agda-subset.ts in.ndjson out.ndjson name@Module... +tableName...
import { readFileSync, writeFileSync } from 'node:fs'

const [input, output, ...wanted] = process.argv.slice(2)
if (!input || !output) throw new Error('usage: agda-subset.ts in.ndjson out.ndjson name@Module...')

// ndjson rows: meta, name table, entries
interface Meta { meta: { count?: number, names?: number } }
interface Name { q: string, n: string, tpl?: unknown, fields?: number[] }
interface Entry { name: string, module: string, term: unknown, unf?: unknown, qname?: number }

const rows = readFileSync(input, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Partial<Meta & Name & Entry>)
const meta = rows[0] as Meta
const names = rows.filter((r): r is Name => typeof r.q === 'string')
const entries = rows.filter((r): r is Entry => typeof r.name === 'string')
// +name keeps table entries
const extra = wanted.filter(w => w.startsWith('+')).map(w => w.slice(1))
const keep = entries.filter(e => wanted.some(w => {
  const [n, m] = w.split('@')
  return e.name === n && (!m || e.module === m)
}))

// renumber names
const used = new Map<number, number>()
const visit = (t: unknown) => {
  if (!Array.isArray(t)) return
  if (t[0] === 'c' && typeof t[1] === 'number') use(t[1])
  t.forEach(visit)
}
// templates and fields too
const visitTpl = (t: unknown) => {
  if (!Array.isArray(t)) return
  if (t[0] === 'C' && typeof t[1] === 'number' && t[1] >= 0) use(t[1])
  t.forEach(visitTpl)
}
const use = (i: number) => {
  if (used.has(i)) return
  used.set(i, used.size)
  visitTpl(names[i]!.tpl)
  for (const f of names[i]!.fields ?? []) use(f)
}
names.forEach((n, i) => {
  if (extra.includes(n.n)) use(i)
})
for (const e of keep) {
  visit(e.term)
  visit(e.unf)
  if (typeof e.qname === 'number') use(e.qname)
}
for (const i of [...used.keys()]) use(i)
const renumber = (t: unknown): unknown => {
  if (!Array.isArray(t)) return t
  if (t[0] === 'c' && typeof t[1] === 'number') return ['c', used.get(t[1])]
  return t.map(renumber)
}
const renumberTpl = (t: unknown): unknown => {
  if (!Array.isArray(t)) return t
  if (t[0] === 'C' && typeof t[1] === 'number') return ['C', used.get(t[1]) ?? -1, ...t.slice(2).map(renumberTpl)]
  return t.map(renumberTpl)
}
const table = [...used].sort((a, b) => a[1] - b[1]).map(([i]) => {
  const n: Name = { ...names[i]! }
  if (n.tpl) n.tpl = renumberTpl(n.tpl)
  if (n.fields) n.fields = n.fields.map(f => used.get(f)!)
  return n
})
const out = keep.map(e => ({ ...e, term: renumber(e.term), ...(e.unf ? { unf: renumber(e.unf) } : {}), qname: e.qname === undefined ? undefined : used.get(e.qname) }))
meta.meta.count = out.length
meta.meta.names = table.length
writeFileSync(output, [meta, ...table, ...out].map(r => JSON.stringify(r)).join('\n') + '\n')
console.log(`${out.length} entries, ${table.length} names`)
