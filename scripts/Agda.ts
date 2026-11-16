// Description:
//   Searches the cubical agda library and agda-stdlib, hoogle style.
//
// Commands:
//   hubot agda <name> - Looks up a definition, e.g. agda isProp->isSet or agda Iso.fun.
//   hubot agda <type> - Finds definitions of a type, e.g. agda isProp A -> isSet A.
//   hubot agda search <words> - Fuzzy name search.
//   hubot agda about <names> - Definitions whose type mentions every name, -name excludes.
//   hubot agda type <type> - Type search, for types without an arrow or equation.
//   hubot agda more - Shows more of the last results.
//   hubot agda index - Shows which library versions are indexed.
//   hubot agda reindex - Reloads the index (owner only).
//

import type { Robot, Response } from 'hubot'

import { ascii, displayType, indexSize, libraries, loadIndex, lookupName, MAX_QUERY, searchAbout, searchNames, searchType, urlFor, type Hit } from './lib/agdaIndex.ts'
import { isOwner, OWNER_ONLY } from './lib/owner.ts'

const RELEASE = 'https://github.com/vikraman/donbot/releases/download/agda-index'
const DEFAULT_SOURCES = `${RELEASE}/cubical.json.gz,${RELEASE}/stdlib.json.gz`
const REFRESH_MS = 24 * 60 * 60 * 1000
const PAGE = 5
const MAX_TYPE = 300
// discord's limit is 2000
const MAX_MESSAGE = 1900

// type-like query, on folded ascii
const TYPE_LIKE = /->|[=<>]|\|\||\*|\s:\s|\bforall\b|\bSigma\b/

interface Page {
  label: string
  hits: Hit[]
  shown: number
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const shortModule = (m: string): string => m.split('.').filter(p => p !== '_').join('.')

const escape = (s: string): string => s.replace(/[\\_*~`|[\]]/g, '\\$&')

const link = (h: Hit): string => {
  const url = urlFor(h)
  const label = escape(shortModule(h.entry.module))
  return url ? `[${label}](<${url}>)` : label
}

const via = (h: Hit): string => (h.via ? ` · up to ${h.via}` : '')

const code = (s: string): string => s.replace(/`/g, "'")

// names as code, _++_ is markdown
const title = (h: Hit): string => `\`${code(h.entry.name)}\` · ${link(h)}${via(h)}`

const single = (h: Hit): string => {
  const head = title(h)
  const body = clip(`${h.entry.name} : ${displayType(h.entry.type, h.lib.name)}`, MAX_MESSAGE - head.length - 20)
  return `${head}\n\`\`\`agda\n${code(body)}\n\`\`\``
}

const item = (h: Hit): string =>
  `${title(h)}\n\`${code(clip(displayType(h.entry.type, h.lib.name), MAX_TYPE))}\``

export default async (robot: Robot) => {
  const sources = (process.env.AGDA_INDEX_URLS || DEFAULT_SOURCES).split(',').map(s => s.trim()).filter(Boolean)
  const pages = new Map<string, Page>()
  let loaded: Promise<void> = Promise.resolve()
  let failure = ''

  const reload = () => {
    loaded = loadIndex(sources).then(
      () => {
        failure = ''
        robot.logger.info(`agda index: ${indexSize()} definitions`)
      },
      (err: Error) => {
        failure = err.message
        robot.logger.error(`agda index: ${err.message}`)
      }
    )
    return loaded
  }
  void reload()
  setInterval(reload, REFRESH_MS).unref()

  const show = async (res: Response, page: Page) => {
    const { hits, shown, label } = page
    if (hits.length === 0) {
      await res.send(`No matches for \`${code(label)}\`.`)
      return
    }
    if (hits.length === 1) {
      await res.send(single(hits[0]!))
      return
    }
    const header = shown === 0 ? `${hits.length >= 200 ? '200+' : hits.length} matches for \`${code(label)}\`:` : `More for \`${code(label)}\`:`
    // fit under the message limit
    let body = ''
    let count = 0
    for (const h of hits.slice(shown, shown + PAGE)) {
      const next = `\n${item(h)}`
      if (count > 0 && header.length + body.length + next.length + 40 > MAX_MESSAGE) break
      body += next
      count++
    }
    page.shown = shown + count
    const left = hits.length - page.shown
    const footer = left > 0 ? `\n_${left} more, say \`agda more\`_` : ''
    await res.send(`${header}${body}${footer}`)
  }

  const answer = async (res: Response, label: string, search: () => Hit[]) => {
    // a reload keeps serving the old index
    if (indexSize() === 0) await loaded
    if (indexSize() === 0) {
      await res.send(failure ? `The Agda index failed to load: ${failure}` : "The Agda index isn't loaded yet.")
      return
    }
    const page = { label, hits: search(), shown: 0 }
    pages.set(res.message.room, page)
    await show(res, page)
  }

  robot.respond(/agda\s+([\s\S]+?)\s*$/i, async res => {
    // discord clients escape markdown, _ arrives as \_
    const q = res.match[1]!.replace(/\\([_*~`|>[\]])/g, '$1').replace(/\s+/g, ' ')
    if (q.length > MAX_QUERY) {
      await res.send(`That query is too long, keep it under ${MAX_QUERY} characters.`)
      return
    }
    const [command, ...rest] = q.split(' ')
    const arg = rest.join(' ')
    switch (command!.toLowerCase()) {
      case 'more': {
        const page = pages.get(res.message.room)
        if (!page || page.shown >= page.hits.length) await res.send('Nothing more to show.')
        else await show(res, page)
        return
      }
      case 'index': {
        await loaded
        const libs = libraries()
        await res.send(libs.length === 0
          ? `No Agda index loaded${failure ? `: ${failure}` : '.'}`
          : libs.map(l => `${l.name}: ${l.count} definitions${l.commit ? ` at ${l.commit.slice(0, 7)}` : ''}`).join('\n'))
        return
      }
      case 'reindex':
        if (!isOwner(res)) {
          await res.send(OWNER_ONLY)
          return
        }
        await reload()
        await res.send(failure ? `Reindex failed: ${failure}` : `Reloaded ${indexSize()} definitions.`)
        return
      case 'search':
        if (arg) return answer(res, arg, () => searchNames(arg))
        break
      case 'about':
        if (arg) return answer(res, arg, () => searchAbout(arg))
        break
      case 'type':
        if (arg) return answer(res, arg, () => searchType(arg))
        break
    }
    // isProp->isSet is a name, isProp A -> isSet A a type
    return answer(res, q, () => {
      const exact = rest.length === 0 ? lookupName(q) : []
      if (exact.length > 0) return exact
      const typed = TYPE_LIKE.test(ascii(q)) ? searchType(q) : []
      return typed.length > 0 ? typed : searchNames(q)
    })
  })
}
