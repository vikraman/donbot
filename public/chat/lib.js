// pure helpers, tested in node

// the markdown donbot writes
const INLINE = new RegExp([
  /\\([\\`*_~|[\]()<>#.+-])/.source,
  /`([^`\n]+)`/.source,
  /\*\*(.+?)\*\*/.source,
  /~~(.+?)~~/.source,
  /\[((?:\\.|[^\]\\])+)\]\(<?(https?:\/\/[^\s>)]+)>?\)/.source,
  /<(https?:\/\/[^\s>]+)>/.source,
  /(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/.source,
  /(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])/.source,
  /(?<!\w)_(?![\s_])([^_\n]+?)_(?!\w)/.source
].join('|'), 'g')

const IMAGE = /\.(png|jpe?g|gif|webp)(\?.*)?$/i

const url = href => ({ t: 'a', href, c: [href], img: IMAGE.test(href) })

// inline markdown -> nodes
export const inline = text => {
  const out = []
  let last = 0
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index))
    last = m.index + m[0].length
    const [, esc, code, bold, strike, label, href, angle, bare, star, under] = m
    if (esc) out.push(esc)
    else if (code) out.push({ t: 'code', c: [code] })
    else if (bold) out.push({ t: 'b', c: inline(bold) })
    else if (strike) out.push({ t: 's', c: inline(strike) })
    else if (label) out.push({ t: 'a', href, c: inline(label) })
    else if (angle || bare) out.push(url(angle || bare))
    else out.push({ t: 'i', c: inline(star || under) })
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

// reply -> blocks
export const parse = text => {
  const blocks = []
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('```')) {
      const body = []
      while (++i < lines.length && !lines[i].startsWith('```')) body.push(lines[i])
      blocks.push({ t: 'pre', c: [body.join('\n')] })
    } else if (line.startsWith('> ')) {
      blocks.push({ t: 'q', c: inline(line.slice(2)) })
    } else {
      blocks.push({ t: 'p', c: inline(line) })
    }
  }
  return blocks
}

// plain text for copy
export const toText = text => {
  const flat = nodes => nodes.map(n => {
    if (typeof n === 'string') return n
    const inner = flat(n.c)
    return n.t === 'a' && inner !== n.href ? `${inner} (${n.href})` : inner
  }).join('')
  return parse(text).map(b => b.t === 'q' ? `> ${flat(b.c)}` : flat(b.c)).join('\n')
}

// expand [options] and a|b
const expand = cmd => {
  const opt = cmd.match(/^(.*?)\s*\[([^\]]+)\](.*)$/)
  if (opt) {
    const [, pre, inner, post] = opt
    // [a|b] lists literal words
    const fills = /^[^\s<|]+(\|[^\s<|]+)+$/.test(inner) ? inner.split('|') : [inner.includes('<') ? inner : `<${inner}>`]
    return [...expand(pre + post), ...fills.flatMap(f => expand(`${pre} ${f}${post}`))]
  }
  const alt = cmd.match(/^([^<]*?)(\S*\|\S*)(.*)$/)
  if (alt && !alt[2].includes('<')) return alt[2].split('|').flatMap(a => expand(alt[1] + a + alt[3]))
  return [cmd.replace(/\s+/g, ' ').trim()]
}

// literal part before placeholders
const head = cmd => cmd.split('<')[0]

// history first, then help
export const complete = (typed, commands, history = [], max = 8) => {
  const q = typed.trimStart().toLowerCase()
  if (!q) return []
  const seen = new Set()
  const out = []
  const add = (text, desc, past) => {
    const key = text.toLowerCase()
    if (seen.has(key) || key === q) return
    seen.add(key)
    out.push({ text, desc, past })
  }
  for (const h of history.slice().reverse()) if (h.toLowerCase().startsWith(q)) add(h, 'from your history', true)
  for (const { cmd, desc } of commands) {
    for (const c of expand(cmd)) {
      if (head(c).toLowerCase().startsWith(q)) add(c, desc, false)
    }
  }
  return out.slice(0, max)
}

// first placeholder range
export const placeholder = text => {
  const m = text.match(/<[^>]+>/)
  return m ? [m.index, m.index + m[0].length] : null
}
