// photo pipeline

import sharp from 'sharp'

import { enhanceBoard } from './board.ts'
import type { EnhanceOptions, EnhanceStats } from './board.ts'

const MAX_EDGE = 2000
export const MAX_DOWNLOAD = 20 * 1024 * 1024

export interface ImageStats {
  inWidth: number
  inHeight: number
  inBytes: number
  outBytes: number
  metadata: 'none' | 'removed' | 'location'
  enhance?: EnhanceStats
}

export interface Prepared {
  data: Uint8Array
  mime: string
  width: number
  height: number
  // focal point, y up
  focus?: { x: number, y: number }
  stats?: ImageStats
}

interface PrepareOptions {
  enhance?: EnhanceOptions
}

export type Prepare = (data: Uint8Array, maxBytes: number, opts?: PrepareOptions) => Promise<Prepared>

sharp.concurrency(1)
sharp.cache(false)

const FOCUS_EDGE = 64
// noise floor
const INK_THRESHOLD = 24

// ink centroid
export const focusOf = (grey: Uint8Array, width: number, height: number): { x: number, y: number } => {
  const sorted = Uint8Array.from(grey).sort()
  const median = sorted[sorted.length >> 1] ?? 128
  let total = 0
  let sx = 0
  let sy = 0
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const w = Math.max(0, Math.abs(grey[y * width + x]! - median) - INK_THRESHOLD)
      total += w
      sx += w * x
      sy += w * y
    }
  }
  if (!total || width < 2 || height < 2) return { x: 0, y: 0 }
  const round = (n: number) => Math.round(n * 100) / 100
  return { x: round((sx / total) / (width - 1) * 2 - 1), y: round(1 - (sy / total) / (height - 1) * 2) }
}

// gps ifd pointer (0x8825) in ifd0
export const hasGps = (exif: Buffer | undefined): boolean => {
  if (!exif) return false
  // "Exif\0\0" then tiff header
  const base = exif.subarray(0, 6).toString('latin1') === 'Exif\0\0' ? 6 : 0
  if (exif.length < base + 8) return false
  const order = exif.subarray(base, base + 2).toString('latin1')
  if (order !== 'II' && order !== 'MM') return false
  const le = order === 'II'
  const u16 = (o: number) => le ? exif.readUInt16LE(o) : exif.readUInt16BE(o)
  const u32 = (o: number) => le ? exif.readUInt32LE(o) : exif.readUInt32BE(o)
  const ifd = base + u32(base + 4)
  if (ifd + 2 > exif.length) return false
  const n = u16(ifd)
  for (let k = 0; k < n && ifd + 2 + 12 * k + 2 <= exif.length; k++) if (u16(ifd + 2 + 12 * k) === 0x8825) return true
  return false
}

const ATTEMPTS: readonly [number, number][] = [[MAX_EDGE, 85], [MAX_EDGE, 75], [MAX_EDGE, 65], [1600, 70], [1280, 70], [1024, 65]]

// one at a time
let chain: Promise<unknown> = Promise.resolve()
const serially = <T>(task: () => Promise<T>): Promise<T> => {
  const next = chain.then(task, task)
  // don't hold the last jpeg
  chain = next.then(() => undefined, () => undefined)
  return next
}

// jpeg under maxBytes, no metadata
export const prepareImage: Prepare = (data, maxBytes, opts = {}) => serially(async () => {
  const input = { limitInputPixels: 100_000_000, failOn: 'error' as const }
  const meta = await sharp(data, input).metadata()
  const turned = (meta.orientation ?? 1) >= 5
  const { data: decoded, info } = await sharp(data, input)
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
    .flatten({ background: '#ffffff' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  let pixels: Uint8Array = decoded
  let width = info.width, height = info.height
  let enhanced: EnhanceStats | undefined
  if (opts.enhance) {
    const result = await enhanceBoard({ data: pixels, width, height }, opts.enhance)
    if (result) {
      pixels = result.image.data
      width = result.image.width
      height = result.image.height
      enhanced = result.stats
    }
  }
  const raw = { raw: { width, height, channels: 3 as const } }
  for (const [edge, quality] of ATTEMPTS) {
    const { data: out, info: o } = await sharp(pixels, raw)
      .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
      // full-res chroma
      .jpeg({ quality, mozjpeg: true, chromaSubsampling: '4:4:4' })
      .toBuffer({ resolveWithObject: true })
    if (o.size > maxBytes) continue
    const small = await sharp(out).resize({ width: FOCUS_EDGE, height: FOCUS_EDGE, fit: 'inside' }).greyscale().raw().toBuffer({ resolveWithObject: true })
    const focus = small.info.channels === 1 ? focusOf(new Uint8Array(small.data), small.info.width, small.info.height) : undefined
    const stats: ImageStats = {
      inWidth: (turned ? meta.height : meta.width) ?? info.width,
      inHeight: (turned ? meta.width : meta.height) ?? info.height,
      inBytes: data.length,
      outBytes: o.size,
      metadata: hasGps(meta.exif) ? 'location' : meta.exif ? 'removed' : 'none',
      ...enhanced ? { enhance: enhanced } : {}
    }
    return { data: new Uint8Array(out), mime: 'image/jpeg', width: o.width, height: o.height, ...focus ? { focus } : {}, stats }
  }
  throw new Error('image is too large even after shrinking')
})
