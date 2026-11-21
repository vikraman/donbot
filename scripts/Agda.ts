// Description:
//   Searches agda libraries (agda-stdlib, cubical and more) by name, type or pattern.
//
// Commands:
//   hubot agda <name|type|pattern> - Searches Agda libraries, e.g. agda isProp A -> isSet A or agda sym (p . q) = ? . ?.
//   hubot agda help [types|patterns|filters|examples] - Shows how to search, with examples.
//   hubot agda more - Shows the next results.
//   hubot agda <n> - Shows result n of the last search in full, and why it matched.
//   hubot agda libs - Lists the indexed libraries.
//   hubot agda reindex - Reloads the index (owner only).
//

import type { Robot, Response } from 'hubot'

import { ascii } from './lib/agda/fold.ts'
import { diagnose, displayType, lookupName, MAX_QUERY, searchAbout, searchNames, searchType, splitFilters, splitParts, urlFor, type Hit } from './lib/agda/search.ts'
import { indexSize, libraries, loadIndex, refresh } from './lib/agda/store.ts'
import { explain } from './lib/agda/explain.ts'
import { isOwner, OWNER_ONLY } from './lib/owner.ts'
import { defineFeature } from './lib/features.ts'
import { link as mdLink, plain } from './lib/markdown.ts'

defineFeature({ id: 'agda', label: 'Agda search', level: 'professional', web: true, help: ['hubot agda'] })

const RELEASE = 'https://github.com/vikraman/donbot/releases/download/agda-index'
// measured on agda 2.9
const DEFAULT_SOURCES = ['cubical', 'stdlib', 'typetopology'].map(l => `${RELEASE}/${l}.ndjson.gz`).join(',')
const REFRESH_MS = 24 * 60 * 60 * 1000
const PAGE = 5
const MAX_TYPE = 300
// discord's limit is 2000
const MAX_MESSAGE = 1900
const MAX_PAGES = 200
const LIMIT = 200

// type-like words
const TYPE_LIKE = /->|[=<>|]|\*|^[_?]|[()]|^⊢/

interface Page {
  // searched text
  header: (n: string) => string
  // query without filters
  query: string
  hits: Hit[]
  shown: number
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const shortModule = (m: string): string => m.split('.').filter(p => p !== '_').join('.')

const link = (h: Hit): string => {
  const url = urlFor(h)
  const label = shortModule(h.entry.module)
  return url ? mdLink(label, url) : plain(label)
}

const via = (h: Hit): string => (h.via ? ` · up to ${h.via}` : '')

const code = (s: string): string => s.replace(/`/g, "'")

// renamed re-export
const alias = (h: Hit): string => (h.entry.alias ? ` · = \`${code(h.entry.alias.split('.').pop()!)}\`` : '')

// names as code
const title = (h: Hit): string => `\`${code(h.entry.name)}\` · ${link(h)}${alias(h)}${via(h)}`

const single = (h: Hit, lead = '', why: string[] = []): string => {
  const head = `${lead}${title(h)}`
  // explanation, whole lines
  let tail = ''
  for (const line of why) {
    if (tail.length + line.length + 1 > MAX_MESSAGE / 3) break
    tail += `\n${line}`
  }
  const body = clip(`${h.entry.name} : ${displayType(h.entry.type, h.lib.name)}`, MAX_MESSAGE - head.length - tail.length - 20)
  return `${head}\n\`\`\`agda\n${code(body)}\n\`\`\`${tail}`
}

// bold numbers, not a list
const item = (h: Hit, n: number): string =>
  `**${n}.** ${title(h)}\n\`${code(clip(displayType(h.entry.type, h.lib.name), MAX_TYPE))}\``

const count = (hits: Hit[]): string => (hits.length >= LIMIT ? `${LIMIT}+` : String(hits.length))

// example and its hits
const ex = (q: string, finds = '', note = ''): string => `\`agda ${q}\`${finds ? ` → ${finds.split(' ').map(n => `\`${n}\``).join(', ')}` : ''}${note ? ` · ${note}` : ''}`

const TOPICS = ['types', 'patterns', 'filters', 'examples']

const help = (topic = ''): string => {
  const libs = libraries().map(l => l.name)
  switch (topic) {
    case 'types': return [
      '**Searching by type.** Write the type you want; arguments may come in any order, and `A ≡ B` also finds `B ≡ A`.',
      ex('(A -> B) -> List A -> List B', 'map'),
      ex('Iso A B -> A = B', 'isoToPath'),
      ex('A ~= B -> B ~= C -> A ~= C', 'compEquiv'),
      ex('x <- xs -> x <- xs ++ ys', '∈-++⁺ˡ'),
      ex('(x : A) -> P x -> Σ[ x ∈ A ] P x', '_,_', 'binders and Σ syntax'),
      ex('u .fst = v .fst -> u = v', 'equivEq', 'projections'),
      'Unicode or ascii: `->` →, `=` ≡, `/=` ≢, `~=` ≃, `.` ∙ or ∘, `<-` ∈, `*` ×, `<=` ≤, `||A||` ∥ A ∥, `\\` λ, `Sigma` Σ, `Pi` Π, `:` ꞉.',
      ex('Sigma[ x <- A ] B x -> A', 'fst', '`Σ[ x ∈ A ] B x`; in TypeTopology `Sigma x : X , A x`'),
      'Single letters and short words like `xs` are variables; anything else must be a name the library has.'
    ].join('\n')
    case 'patterns': return [
      '**Searching by pattern.** A pattern matches what a lemma proves, then anything inside its type. `?` is a hole (`_` works too).',
      ex('sym (p . q) = ? . ?', 'symDistr'),
      ex('cong f (p . q) = ?', 'cong-∙'),
      ex('length (xs ++ ys) = ?', 'length-++'),
      ex('transport refl x = x', 'transportRefl'),
      ex('Square p q r s -> Square r s p q', 'flipSquare', 'a variable used twice is the same term, different ones stay different'),
      ex('⊢ isSet (? -> ?)', '', '`⊢` (or `|-`) only matches what lemmas prove'),
      'Commas combine parts that must all hold:',
      ex('? . ? = ?, "assoc"', '', '`"…"` is part of the name'),
      ex('isProp, ∥_∥₁, -isSet', '', 'mentions both names, but not `isSet`')
    ].join('\n')
    case 'filters': return [
      '**Filters** go anywhere in a query. On their own they list definitions.',
      '`lib:stdlib` or `lib:stdlib,cubical` · only these libraries; `-lib:cubical` leaves one out',
      '`in:Data.List` · in modules with these name parts; `-in:Base` leaves them out',
      '`kind:data` · also `record`, `con`, `field`, `fun`, `postulate`, `prim`',
      ex('a * b = b * a lib:stdlib', '*-comm'),
      ex('in:Cubical.HITs.S1 kind:data', 'S¹'),
      `Libraries here: ${libs.map(l => `\`${l}\``).join(', ') || 'none loaded yet'}; \`agda libs\` shows their versions.`
    ].join('\n')
    case 'examples': return [
      '**Things to try**',
      ex('isProp B -> (A -> B) -> ||A|| -> B', 'rec', 'out of a propositional truncation'),
      ex('PathP (λ i → p i ≡ q i) r s -> PathP (λ i → r i ≡ s i) p q', 'flipSquare'),
      ex('isProp ? -> isProp ? -> isProp (? * ?)', 'isProp×'),
      ex('m <= n -> n <= m -> m = n', '≤-antisym'),
      ex('map (f . g) xs = ?', 'map-∘'),
      ex('reverse (reverse xs) = xs', 'reverse-involutive'),
      ex('Σ x ꞉ X , A x -> X', 'pr₁', "in TypeTopology's notation"),
      ex('Square p q p q', 'compPath→Square', 'then `agda 2` shows how it fits')
    ].join('\n')
  }
  return [
    `**Agda search**${libs.length > 0 ? ` over ${libs.join(', ')}` : ''}. Type a name, a type, or a pattern:`,
    ex('isProp->isSet', '', 'a name, ascii works'),
    ex('isProp A -> isSet A', 'isProp→isSet', 'a type'),
    ex('sym (p . q) = ? . ?', 'symDistr', 'a pattern, `?` is a hole'),
    ex('"iso path"', 'isoToPath', 'names, forgiving typos'),
    'Then `agda 2` shows result 2 in full and why it matched, `agda more` the next page.',
    `More: ${TOPICS.map(t => `\`agda help ${t}\``).join(' · ')} · \`agda libs\``
  ].join('\n')
}

const libsText = (failure: string): string => {
  const libs = libraries()
  if (libs.length === 0) return `No Agda index loaded${failure ? `: ${failure}` : '.'}`
  const line = (l: (typeof libs)[number]) => {
    const at = l.commit ? ` at ${l.source ? mdLink(l.commit.slice(0, 7), l.source) : l.commit.slice(0, 7)}` : ''
    return `**${l.name}** · ${l.count.toLocaleString('en')} definitions${at}`
  }
  const agda = [...new Set(libs.map(l => l.agda).filter(Boolean))]
  return [...libs.map(line), ...(agda.length > 0 ? [`_checked with Agda ${agda.join(', ')}_`] : [])].join('\n')
}

// bare names
const NAMES_ONLY = /^-?[^\s"()]+$/

export default (robot: Robot) => {
  const sources = (process.env.AGDA_INDEX_URLS || DEFAULT_SOURCES).split(',').map(s => s.trim()).filter(Boolean)
  const pages = new Map<string, Page>()
  let loaded: Promise<void> = Promise.resolve()
  let failure = ''

  // reuse redis state
  const reload = (force = false) => {
    // queued in order
    void refresh().catch(() => false)
    loaded = loadIndex(sources, force).then(
      ({ loaded, skipped }) => {
        failure = ''
        robot.logger.info(`agda index: ${indexSize()} definitions${loaded.length > 0 ? `, loaded ${loaded.join(', ')}` : ''}`)
        for (const s of skipped) robot.logger.warn(`agda index skipped ${s}`)
      },
      (err: Error) => {
        failure = err.message
        robot.logger.error(`agda index: ${err.message}`)
      }
    )
    return loaded
  }
  void reload()
  setInterval(() => void reload(), REFRESH_MS).unref()

  const show = async (res: Response, page: Page) => {
    const { hits, shown } = page
    const header = shown === 0 ? `${page.header(count(hits))}:` : 'More:'
    // fit the limit
    let body = ''
    let n = 0
    for (const h of hits.slice(shown, shown + PAGE)) {
      const next = `\n${item(h, shown + n + 1)}`
      if (n > 0 && header.length + body.length + next.length + 60 > MAX_MESSAGE) break
      body += next
      n++
    }
    page.shown = shown + n
    const left = hits.length - page.shown
    const footer = `\n_${left > 0 ? `${left} more: \`agda more\` · ` : ''}\`agda ${shown + 1}\` shows one in full and why it matched_`
    await res.send(`${header}${body}${footer}`)
  }

  // no hits, and why
  const nothing = async (res: Response, label: string, query: string, filter: string) => {
    // best effort
    const { unknown, parsed, complex } = query ? await diagnose(query, filter).catch(() => ({ unknown: [], parsed: true, complex: false })) : { unknown: [], parsed: true, complex: false }
    const names = unknown.map(w => `\`${code(w)}\``).join(', ')
    const why = complex ? 'It reduces to a term too large to search, try it without λs applied to λs.'
      : unknown.length > 0
      ? `${names} ${unknown.length > 1 ? "aren't names" : "isn't a name"} ${filter ? 'in those libraries' : 'I know'}; \`agda "${code(unknown[0]!)}"\` searches for similar ones.`
      : !parsed ? "I couldn't read it, check the brackets and that operators like `_∙_` have their arguments."
      : 'Try fewer details, e.g. holes `?` for parts you don\'t know, or `⊢` to match only what lemmas prove.'
    await res.send(`No matches for \`${code(label)}\`. ${why} More in \`agda help\`.`)
  }

  const ready = async (res: Response): Promise<boolean> => {
    // old index serves during reload
    if (indexSize() === 0) await loaded
    if (indexSize() > 0) return true
    await res.send(failure ? `The Agda index failed to load: ${failure}` : 'The Agda index is still loading, try again in a minute.')
    return false
  }

  // query kind by shape
  const run = async (query: string, filter: string, label: string): Promise<{ hits: Hit[], header: (n: string) => string, note?: string }> => {
    const quoted = /^"([^"]+)"$/.exec(query)
    const names = (q: string) => searchNames(q, filter)
    if (!query) return { hits: await names(''), header: n => `${n} definitions in \`${code(label)}\`` }
    if (quoted) return { hits: await names(quoted[1]!), header: n => `${n} names like \`${code(quoted[1]!)}\`` }
    const words = query.split(' ')
    const parts = splitParts(query)
    if (words.length === 1) {
      const exact = await lookupName(query, filter)
      if (exact.length > 0) return { hits: exact, header: n => `${n} definitions named \`${code(query)}\`` }
    }
    if (parts.length > 1 && parts.every(p => NAMES_ONLY.test(p))) {
      const hits = await searchAbout(parts.join(' '), filter)
      if (hits.length > 0) return { hits, header: n => `${n} definitions mentioning ${parts.map(p => `\`${code(p)}\``).join(', ')}` }
    }
    // lone word is a name
    if (words.length > 1 || parts.length > 1 || TYPE_LIKE.test(ascii(query))) {
      const hits = await searchType(query, filter)
      if (hits.length > 0) return { hits, header: n => `${n} matches for \`${code(label)}\`` }
    }
    // names despite typos
    if (words.length > 1 && TYPE_LIKE.test(ascii(query))) return { hits: [], header: n => n }
    const fuzzy = await names(query)
    return { hits: fuzzy, header: n => `${n} names like \`${code(label)}\``, note: 'Closest name: ' }
  }

  const answer = async (res: Response, q: string) => {
    if (q.length > MAX_QUERY) {
      await res.send(`That query is too long, keep it under ${MAX_QUERY} characters.`)
      return
    }
    if (!(await ready(res))) return
    const { query, filter, error } = splitFilters(q)
    if (error) {
      await res.send(error)
      return
    }
    let found: Awaited<ReturnType<typeof run>>
    try {
      found = await run(query, filter, q)
    } catch (err) {
      robot.logger.error(`agda search: ${(err as Error).message}`)
      await res.send('The Agda search failed, try again in a bit.')
      return
    }
    const { hits, header, note } = found
    const page: Page = { header, query, hits, shown: 0 }
    pages.delete(res.message.room)
    pages.set(res.message.room, page)
    // room per web visitor
    if (pages.size > MAX_PAGES) pages.delete(pages.keys().next().value!)
    if (hits.length === 0) return nothing(res, q, query, filter)
    if (hits.length === 1) {
      page.shown = 1
      return res.send(single(hits[0]!, note ?? '', await explain(hits[0]!, query).catch(() => [] as string[])))
    }
    await show(res, page)
  }

  robot.respond(/agda(?:\s+([\s\S]*?))?\s*$/i, { id: 'agda.search' }, async res => {
    const q = (res.match[1] ?? '').replace(/\s+/g, ' ').trim()
    const word = q.toLowerCase()
    const topic = /^help\s+(\S+)$/.exec(word)?.[1]
    if (!q || word === 'help' || word === '?') return res.send(help())
    if (topic) return res.send(TOPICS.includes(topic) ? help(topic) : `There's no help on \`${code(topic)}\`, try ${TOPICS.map(t => `\`agda help ${t}\``).join(', ')}.`)
    const first = 'search first, e.g. `agda isProp A -> isSet A`'
    if (word === 'more') {
      const page = pages.get(res.message.room)
      if (!page) return res.send(`Nothing to show yet, ${first}.`)
      if (page.shown >= page.hits.length) return res.send(page.hits.length === 1 ? 'That was the only result.' : `That's all ${page.hits.length}.`)
      return show(res, page)
    }
    if (/^\d+$/.test(word)) {
      const page = pages.get(res.message.room)
      const h = page?.hits[Number(word) - 1]
      if (!page) return res.send(`Nothing to show yet, ${first}, then \`agda 1\`.`)
      if (!h) return res.send(`There's no result ${word}, the last search found ${page.hits.length}.`)
      // explain type matches
      const why = await explain(h, page.query).catch(() => [] as string[])
      return res.send(single(h, '', why))
    }
    if (word === 'libs') {
      await loaded
      return res.send(libsText(failure))
    }
    if (word === 'reindex') {
      if (!isOwner(res)) return res.send(OWNER_ONLY)
      await reload(true)
      return res.send(failure ? `Reindex failed: ${failure}` : `Reloaded ${indexSize()} definitions.`)
    }
    return answer(res, q)
  })
}
