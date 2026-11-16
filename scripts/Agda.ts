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

import { displayType, indexSize, libraries, loadIndex, lookupName, searchAbout, searchNames, searchType, urlFor, type Hit } from './lib/agdaIndex.ts'
import { isOwner, OWNER_ONLY } from './lib/owner.ts'

const RELEASE = 'https://github.com/vikraman/donbot/releases/download/agda-index'
const DEFAULT_SOURCES = `${RELEASE}/cubical.json.gz,${RELEASE}/stdlib.json.gz`
const REFRESH_MS = 24 * 60 * 60 * 1000
const PAGE = 5
const MAX_TYPE = 300

// a query that reads as a type rather than a name
const TYPE_LIKE = /->|→|≡|≃|~=|(?<![~<>/=!])==?(?![~=>?])|\s:\s/

interface Page {
  label: string
  hits: Hit[]
  shown: number
}

const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

const shortModule = (m: string): string => m.split('.').filter(p => p !== '_').join('.')

const link = (h: Hit): string => {
  const url = urlFor(h)
  const label = shortModule(h.entry.module)
  return url ? `[${label}](<${url}>)` : label
}

const single = (h: Hit): string =>
  `**${h.entry.name}** · ${link(h)}\n\`\`\`agda\n${h.entry.name} : ${displayType(h.entry.type, h.lib.name)}\n\`\`\``

const item = (h: Hit): string =>
  `**${h.entry.name}** · ${link(h)}\n\`${clip(displayType(h.entry.type, h.lib.name), MAX_TYPE).replace(/`/g, "'")}\``

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
      await res.send(`No matches for \`${label}\`.`)
      return
    }
    if (hits.length === 1) {
      await res.send(single(hits[0]!))
      return
    }
    const batch = hits.slice(shown, shown + PAGE)
    page.shown = shown + batch.length
    const left = hits.length - page.shown
    const header = shown === 0 ? `${hits.length >= 200 ? '200+' : hits.length} matches for \`${label}\`:` : `More for \`${label}\`:`
    const footer = left > 0 ? `\n_${left} more, say \`agda more\`_` : ''
    await res.send(`${header}\n${batch.map(item).join('\n')}${footer}`)
  }

  const answer = async (res: Response, label: string, search: () => Hit[]) => {
    await loaded
    if (indexSize() === 0) {
      await res.send(failure ? `The Agda index failed to load: ${failure}` : "The Agda index isn't loaded yet.")
      return
    }
    const page = { label, hits: search(), shown: 0 }
    pages.set(res.message.room, page)
    await show(res, page)
  }

  robot.respond(/agda\s+(.+?)\s*$/i, async res => {
    const q = res.match[1]!
    const [command, ...rest] = q.split(/\s+/)
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
      return TYPE_LIKE.test(q) ? searchType(q) : searchNames(q)
    })
  })
}
