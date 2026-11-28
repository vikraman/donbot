// captions, alts, facets

import { MAX_PHOTOS } from '../enhance/photos.ts'


export const DEFAULT_ALT = 'Whiteboard photo'

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })

export const graphemes = (text: string): number => [...segmenter.segment(text)].length

export const codepoints = (text: string): number => [...text].length

const ALT_LINE = /^\s*alt(?:\s*(\d+))?\s*:\s*(.*?)\s*$/i

// alt lines
export const parseAlts = (text: string): { body: string, alts: (string | undefined)[] } => {
  const alts: (string | undefined)[] = []
  const numbered: [number, string][] = []
  const plain: string[] = []
  const body: string[] = []
  for (const line of text.split('\n')) {
    const m = ALT_LINE.exec(line)
    if (!m) {
      body.push(line)
      continue
    }
    const alt = m[2]!.slice(0, 1500)
    if (!alt) continue
    if (m[1]) numbered.push([Number(m[1]), alt])
    else plain.push(alt)
  }
  for (const [n, alt] of numbered) if (n >= 1 && n <= MAX_PHOTOS) alts[n - 1] = alt
  let slot = 0
  for (const alt of plain) {
    while (alts[slot] !== undefined) slot++
    if (slot >= MAX_PHOTOS) break
    alts[slot] = alt
  }
  return { body: body.join('\n').trim(), alts }
}

// discord markup to plain text
export const cleanText = (text: string, nameOf: (id: string) => string | undefined = () => undefined): string =>
  text
    .replace(/<@!?(\d+)>/g, (_m, id: string) => nameOf(id) ?? '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/<(https?:\/\/[^>\s]+)>/g, '$1')
    .replace(/\|\|([\s\S]*?)\|\|/g, '$1')
    .replace(/@(everyone|here)\b/g, '$1')
    .split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim()).join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

// word-boundary cut
export const truncate = (text: string, max: number, count: (s: string) => number = graphemes): string => {
  if (count(text) <= max) return text
  if (max < 1) return ''
  const parts = [...segmenter.segment(text)].map(s => s.segment)
  let cut = parts.slice(0, Math.max(max - 1, 0)).join('')
  const space = cut.search(/\s\S*$/)
  if (space > cut.length / 2) cut = cut.slice(0, space)
  cut = cut.trimEnd()
  while (cut && count(`${cut}…`) > max) cut = [...segmenter.segment(cut)].slice(0, -1).map(s => s.segment).join('')
  return `${cut}…`
}

// body plus tag, fitted
export const fitCaption = (body: string, tag: string, max: number, count: (s: string) => number = graphemes): string => {
  const suffix = tag && !body.toLowerCase().includes(tag.toLowerCase()) ? tag : ''
  const join = (b: string) => [b, suffix].filter(Boolean).join(b ? '\n\n' : '')
  if (count(join(body)) <= max) return join(body)
  const room = max - (suffix ? count(suffix) + 2 : 0)
  if (room < 10) return truncate(join(body), max, count)
  return join(truncate(body, room, count))
}

interface Facet {
  index: { byteStart: number, byteEnd: number }
  features: ({ $type: 'app.bsky.richtext.facet#link', uri: string } | { $type: 'app.bsky.richtext.facet#tag', tag: string })[]
}

const encoder = new TextEncoder()
const bytes = (s: string): number => encoder.encode(s).length

const LINK = /https?:\/\/[^\s<>]+/g
const TAG = /(^|[^\w&])#([\p{L}\p{N}_]*\p{L}[\p{L}\p{N}_]*)/gu

// links and tags, utf-8 offsets
export const facetsFor = (text: string): Facet[] => {
  const found: Facet[] = []
  for (const m of text.matchAll(LINK)) {
    const uri = m[0].replace(/[.,;:!?)\]'"]+$/, '')
    const start = m.index
    found.push({ index: { byteStart: bytes(text.slice(0, start)), byteEnd: bytes(text.slice(0, start + uri.length)) }, features: [{ $type: 'app.bsky.richtext.facet#link', uri }] })
  }
  for (const m of text.matchAll(TAG)) {
    const start = m.index + m[1]!.length
    const tag = m[2]!.slice(0, 64)
    const byteStart = bytes(text.slice(0, start))
    // tags inside links
    if (found.some(f => byteStart >= f.index.byteStart && byteStart < f.index.byteEnd)) continue
    found.push({ index: { byteStart, byteEnd: byteStart + bytes(`#${tag}`) }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag }] })
  }
  return found.sort((a, b) => a.index.byteStart - b.index.byteStart)
}

// hashtags
export const parseTags = (text: string): string =>
  [...text.matchAll(/#?([\p{L}\p{N}_]+)/gu)].map(m => `#${m[1]}`).slice(0, 5).join(' ')
