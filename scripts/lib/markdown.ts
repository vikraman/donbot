// discord markdown, escaping only what would format

export const ZWSP = '\u200b'

// no trailing punctuation or parens
const URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/gi

// markers format in pairs; _ at word edges
const paired = (text: string, mark: RegExp): boolean => (text.match(mark) ?? []).length >= 2

const escapeMarks = (text: string, whole: string): string => {
  let t = text
  // keep literal backslashes
  t = t.replace(/\\(?=[\\*_~|[\]<>])/g, '\\\\')
  // backticks stay
  for (const ch of ['*', '~', '|']) {
    if (paired(whole, new RegExp(`\\${ch}`, 'g'))) t = t.replace(new RegExp(`\\${ch}`, 'g'), `\\${ch}`)
  }
  if (paired(whole, /(?<!\w)_|_(?!\w)/g)) t = t.replace(/(?<!\w)_|_(?!\w)/g, '\\_')
  if (/\]\(/.test(whole)) t = t.replace(/[[\]]/g, '\\$&')
  return t
}

// one line, no formatting, pings or previews
export const plain = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim()
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    .replace(/<([@#])/g, `<${ZWSP}$1`)
  const words = flat.replace(URL, ' ')
  let out = ''
  let last = 0
  for (const m of flat.matchAll(URL)) {
    out += escapeMarks(flat.slice(last, m.index), words) + `<${m[0]}>`
    last = m.index + m[0].length
  }
  return out + escapeMarks(flat.slice(last), words)
}

// <> stops previews; urls in the label are defused
export const link = (label: string, url: string): string =>
  `[${plain(label.replace(/:\/\//g, `:${ZWSP}//`)).replace(/(?<!\\)[[\]]/g, '\\$&')}](<${url.replace(/[<> ]/g, encodeURIComponent)}>)`

// inline code can't hold a backtick
export const code = (text: string): string => `\`${text.replace(/`/g, "'")}\``

export const MESSAGE_LIMIT = 2000

// split at lines, then spaces; reopen cut code blocks
export const splitMessage = (text: string, limit = MESSAGE_LIMIT): string[] => {
  const chunks: string[] = []
  let current = ''
  let fence = false
  const flush = () => {
    if (!current) return
    chunks.push(fence ? `${current}\n\`\`\`` : current)
    current = fence ? '```' : ''
  }
  const lines = text.split('\n').flatMap(line => {
    const parts: string[] = []
    let rest = line
    // room for a reopened fence and its newline
    const max = limit - 8
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max) > max / 2 ? rest.lastIndexOf(' ', max) : max
      parts.push(rest.slice(0, cut))
      rest = rest.slice(cut).replace(/^ /, '')
    }
    return [...parts, rest]
  })
  for (const line of lines) {
    if (current && current.length + 1 + line.length > limit - 4) flush()
    current = current ? `${current}\n${line}` : line
    if ((line.match(/```/g) ?? []).length % 2 === 1) fence = !fence
  }
  if (current && current !== '```') chunks.push(current)
  return chunks
}
