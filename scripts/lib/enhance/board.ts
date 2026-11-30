// board enhancement

import sharp from 'sharp'

export type Preset = 'mild' | 'strong' | 'off'
export type Clean = 'off' | 'low' | 'normal' | 'high'
export type CropMode = 'off' | 'box' | 'straighten'
export type BoardKind = 'auto' | 'white' | 'black'

export interface EnhanceOptions {
  // board clean-up
  enhance: boolean
  // whiteboard lift, 0-1
  brightness: number
  // tone curve, 0-1
  contrast: number
  // saturation
  color: number
  // haze clearing
  clean: Clean
  // straighten falls back to box
  crop: CropMode
  board: BoardKind
}

export const PRESETS: Record<Preset, EnhanceOptions> = {
  mild: { enhance: true, brightness: 0.5, contrast: 0, color: 1, clean: 'normal', crop: 'straighten', board: 'auto' },
  strong: { enhance: true, brightness: 1, contrast: 1, color: 1.6, clean: 'normal', crop: 'straighten', board: 'auto' },
  off: { enhance: false, brightness: 0.5, contrast: 0, color: 1, clean: 'normal', crop: 'off', board: 'auto' }
}

// preset resets, rest override
export interface EnhanceSpec extends Partial<EnhanceOptions> {
  preset?: Preset
}

export const resolveEnhance = (...specs: (EnhanceSpec | undefined)[]): EnhanceOptions => {
  let out: EnhanceOptions = { ...PRESETS.mild }
  for (const spec of specs) {
    if (!spec) continue
    const { preset, ...knobs } = spec
    if (preset) out = { ...PRESETS[preset] }
    out = { ...out, ...knobs }
  }
  return out
}

// settings as text
export const describeOptions = (o: EnhanceOptions): string =>
  o.enhance
    ? `brightness ${Math.round(o.brightness * 100)}, contrast ${Math.round(o.contrast * 100)}, color ${Math.round(o.color * 100)}, clean ${o.clean}, crop ${o.crop}`
    : `no clean-up, crop ${o.crop}`

// preset name or custom
export const labelOf = (o: EnhanceOptions): string => {
  const same = (a: EnhanceOptions, b: EnhanceOptions) => a.enhance === b.enhance && a.brightness === b.brightness && a.contrast === b.contrast && a.color === b.color && a.clean === b.clean
  return (Object.keys(PRESETS) as Preset[]).find(k => same(o, PRESETS[k])) ?? 'custom'
}

export interface EnhanceStats {
  label: string
  enhanced: boolean
  board: 'whiteboard' | 'blackboard'
  // detection
  found: 'frame' | 'frame+colour' | 'colour' | 'whole photo'
  // share of photo
  coverage: number
  skipped?: boolean
  // lighting spread p10-p90
  unevenBefore: number
  unevenAfter: number
  // board brightness
  brightBefore: number
  brightAfter: number
  // ink-board gap
  contrastBefore: number
  contrastAfter: number
  // share of board cleared
  cleaned: number
  // crop applied
  cropped?: 'box' | 'straightened'
  // crop skipped: writing off board
  outside?: number
}

export interface Raw {
  data: Uint8Array
  width: number
  height: number
}

const lum = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

const clamp01 = (v: number) => v < 0 ? 0 : v > 1 ? 1 : v

// percentile from a 0-255 histogram
const histPct = (hist: Uint32Array, q: number): number => {
  const total = hist.reduce((a, v) => a + v, 0)
  let seen = 0
  for (let v = 0; v < 256; v++) {
    seen += hist[v]!
    if (seen > total * q) return v
  }
  return 255
}

const pct = (sorted: ArrayLike<number>, q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * q)))] ?? 0

// second board in shot
const MAX_OUTSIDE = 0.35

const CLEAN_MAD: Record<Exclude<Clean, 'off'>, number> = { low: 9, normal: 6, high: 4 }

// separable min/max
const morph1 = (src: Uint8Array, w: number, h: number, c: number, size: number, max: boolean): Uint8Array => {
  const r = size >> 1
  const tmp = new Uint8Array(src.length)
  const out = new Uint8Array(src.length)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < c; k++) {
    let acc = max ? 0 : 255
    for (let d = -r; d <= r; d++) {
      const v = src[(y * w + Math.min(w - 1, Math.max(0, x + d))) * c + k]!
      acc = max ? (v > acc ? v : acc) : (v < acc ? v : acc)
    }
    tmp[(y * w + x) * c + k] = acc
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let k = 0; k < c; k++) {
    let acc = max ? 0 : 255
    for (let d = -r; d <= r; d++) {
      const v = tmp[(Math.min(h - 1, Math.max(0, y + d)) * w + x) * c + k]!
      acc = max ? (v > acc ? v : acc) : (v < acc ? v : acc)
    }
    out[(y * w + x) * c + k] = acc
  }
  return out
}
const dilate = (s: Uint8Array, w: number, h: number, c: number, size: number) => morph1(s, w, h, c, size, true)
const erode = (s: Uint8Array, w: number, h: number, c: number, size: number) => morph1(s, w, h, c, size, false)
const open = (s: Uint8Array, w: number, h: number, c: number, size: number) => dilate(erode(s, w, h, c, size), w, h, c, size)
const close = (s: Uint8Array, w: number, h: number, c: number, size: number) => erode(dilate(s, w, h, c, size), w, h, c, size)

// srgb to 8-bit lab
const toLab = (rgb: Uint8Array): Uint8Array => {
  const lin = new Float32Array(256)
  for (let v = 0; v < 256; v++) lin[v] = v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4
  const f = (t: number) => t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116
  const lab = new Uint8Array(rgb.length)
  for (let i = 0; i < rgb.length; i += 3) {
    const r = lin[rgb[i]!]!, g = lin[rgb[i + 1]!]!, b = lin[rgb[i + 2]!]!
    const X = (0.412453 * r + 0.357580 * g + 0.180423 * b) / 0.950456
    const Y = 0.212671 * r + 0.715160 * g + 0.072169 * b
    const Z = (0.019334 * r + 0.119193 * g + 0.950227 * b) / 1.088754
    lab[i] = Math.round((Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y) * 2.55)
    lab[i + 1] = Math.round(500 * (f(X) - f(Y)) + 128)
    lab[i + 2] = Math.round(200 * (f(Y) - f(Z)) + 128)
  }
  return lab
}

// convex fill
const fillConvex = (pts: [number, number][], w: number, h: number): Uint8Array => {
  const out = new Uint8Array(w * h)
  const lo = new Float64Array(h).fill(Infinity)
  const hi = new Float64Array(h).fill(-Infinity)
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i]!
    const [x1, y1] = pts[(i + 1) % pts.length]!
    const ya = Math.max(0, Math.ceil(Math.min(y0, y1))), yb = Math.min(h - 1, Math.floor(Math.max(y0, y1)))
    for (let y = ya; y <= yb; y++) {
      const x = y1 === y0 ? Math.min(x0, x1) : x0 + (x1 - x0) * (y - y0) / (y1 - y0)
      const x2 = y1 === y0 ? Math.max(x0, x1) : x
      if (x < lo[y]!) lo[y] = x
      if (x2 > hi[y]!) hi[y] = x2
    }
  }
  for (let y = 0; y < h; y++) for (let x = Math.max(0, Math.ceil(lo[y]!)); x <= Math.min(w - 1, hi[y]!); x++) out[y * w + x] = 255
  return out
}

const hullOf = (pts: [number, number][]): [number, number][] => {
  const sorted = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1])
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const half = (list: [number, number][]) => {
    const out: [number, number][] = []
    for (const p of list) {
      while (out.length >= 2 && cross(out.at(-2)!, out.at(-1)!, p) <= 0) out.pop()
      out.push(p)
    }
    return out.slice(0, -1)
  }
  return [...half(sorted), ...half(sorted.slice().reverse())]
}

// board-coloured hull
const colourRegion = (rgb: Uint8Array, w: number, h: number): Uint8Array => {
  const smooth = close(open(toLab(rgb), w, h, 3, 7), w, h, 3, 7)
  const box: number[] = []
  for (let y = Math.floor(h * 0.3); y < h * 0.7; y += 2) for (let x = Math.floor(w * 0.3); x < w * 0.7; x += 2) box.push((y * w + x) * 3)
  const seed = [0, 1, 2].map(c => box.map(i => smooth[i + c]!).sort((a, b) => a - b)[box.length >> 1] ?? 0) as [number, number, number]
  const dist = (i: number) => Math.hypot((smooth[i]! - seed[0]) * 0.5, smooth[i + 1]! - seed[1], smooth[i + 2]! - seed[2])
  const ds = box.map(dist).sort((a, b) => a - b)
  const tol = Math.min(45, Math.max(14, 2.5 * pct(ds, 0.8)))
  const lightSeed = seed[0] > 150
  let mask: Uint8Array = new Uint8Array(w * h)
  for (let p = 0, i = 0; p < w * h; p++, i += 3) {
    // glare counts as board
    const glare = lightSeed && smooth[i]! > seed[0] && Math.abs(smooth[i + 1]! - 128) < 10 && Math.abs(smooth[i + 2]! - 128) < 14
    mask[p] = dist(i) < tol || glare ? 255 : 0
  }
  mask = open(close(mask, w, h, 1, 25), w, h, 1, 7)
  // centre component
  const label = new Int32Array(w * h)
  let n = 0
  const stack = new Int32Array(w * h)
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || label[s]) continue
    label[s] = ++n
    let top = 0
    stack[top++] = s
    while (top) {
      const i = stack[--top]!
      const x = i % w
      const visit = (j: number) => { if (mask[j] && !label[j]) { label[j] = n; stack[top++] = j } }
      if (x > 0) visit(i - 1)
      if (x < w - 1) visit(i + 1)
      if (i >= w) visit(i - w)
      if (i < w * (h - 1)) visit(i + w)
    }
  }
  const counts = new Map<number, number>()
  for (let y = Math.floor(h * 0.35); y < h * 0.65; y += 3) for (let x = Math.floor(w * 0.35); x < w * 0.65; x += 3) {
    const l = label[y * w + x]!
    if (l) counts.set(l, (counts.get(l) ?? 0) + 1)
  }
  const best = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]
  if (!best) return new Uint8Array(w * h)
  const pts: [number, number][] = []
  for (let y = 0; y < h; y++) {
    let a = -1, b = -1
    for (let x = 0; x < w; x++) if (label[y * w + x] === best) { if (a < 0) a = x; b = x }
    if (a >= 0) pts.push([a, y], [b, y])
  }
  return fillConvex(hullOf(pts), w, h)
}

interface Line {
  o: number
  s: number
  border?: boolean
}

// frame rectangle
type Pt = [number, number]

const frameRegion = (grey: Uint8Array, median: Uint8Array, w: number, h: number, light: boolean, within: Uint8Array): { mask: Uint8Array, cov: number, corners: Pt[], ink: number, inkAll: number } | undefined => {
  // ink tables
  const ii = new Float64Array((w + 1) * (h + 1))
  const iiAll = new Float64Array((w + 1) * (h + 1))
  let total = 0, totalAll = 0
  for (let y = 0; y < h; y++) {
    let row = 0, rowAll = 0
    for (let x = 0; x < w; x++) {
      const d = grey[y * w + x]! - median[y * w + x]!
      const ink = light ? d < -30 : d > 30
      const v = ink && within[y * w + x]! > 127 ? 1 : 0
      row += v
      total += v
      if (ink) { rowAll++; totalAll++ }
      ii[(y + 1) * (w + 1) + x + 1] = ii[y * (w + 1) + x + 1]! + row
      iiAll[(y + 1) * (w + 1) + x + 1] = iiAll[y * (w + 1) + x + 1]! + rowAll
    }
  }
  if (total < 200) return undefined
  const eh = new Uint8Array(w * h), ev = new Uint8Array(w * h)
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const p = (dx: number, dy: number) => grey[(y + dy) * w + x + dx]!
    const gx = Math.abs(p(1, -1) + 2 * p(1, 0) + p(1, 1) - p(-1, -1) - 2 * p(-1, 0) - p(-1, 1)) / 4
    const gy = Math.abs(p(-1, 1) + 2 * p(0, 1) + p(1, 1) - p(-1, -1) - 2 * p(0, -1) - p(1, -1)) / 4
    if (gy >= 12 && gy >= 2 * gx) eh[y * w + x] = 1
    if (gx >= 12 && gx >= 2 * gy) ev[y * w + x] = 1
  }
  const slopes: number[] = []
  for (let s = -0.15; s <= 0.1501; s += 0.005) slopes.push(s)
  const cx = w / 2, cy = h / 2
  const candidates = (horiz: boolean): Line[] => {
    const len = horiz ? h : w, span = horiz ? w : h, e = horiz ? eh : ev
    const votes = new Float32Array(slopes.length * len)
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      if (!e[y * w + x]) continue
      for (let k = 0; k < slopes.length; k++) {
        const o = Math.round(horiz ? y - slopes[k]! * (x - cx) : x - slopes[k]! * (y - cy))
        if (o >= 0 && o < len) votes[k * len + o]!++
      }
    }
    const best: { o: number, s: number, support: number }[] = []
    for (let o = 0; o < len; o++) {
      let v = 0, sl = 0
      for (let k = 0; k < slopes.length; k++) {
        const c = votes[k * len + o]! + 0.5 * ((votes[k * len + o - 1] ?? 0) + (votes[k * len + o + 1] ?? 0))
        if (c > v) { v = c; sl = slopes[k]! }
      }
      best.push({ o, s: sl, support: v / span })
    }
    const peaks = best.filter((c, i) => c.support >= 0.2 && best.slice(Math.max(0, i - 6), i + 7).every(d => d.support <= c.support))
    peaks.sort((a, b) => b.support - a.support)
    return [...peaks.slice(0, 8), { o: 0, s: 0, border: true }, { o: len - 1, s: 0, border: true }]
  }
  const H = candidates(true), V = candidates(false)
  const at = (line: Line, t: number, horiz: boolean) => line.o + line.s * (t - (horiz ? cx : cy))
  // side edge coverage
  const coverage = (line: Line, horiz: boolean, from: number, to: number): number => {
    if (line.border) return 0.3
    const e = horiz ? eh : ev
    let hit = 0, n = 0
    for (let t = Math.max(1, Math.round(from)); t < Math.min(horiz ? w : h, Math.round(to)) - 1; t++) {
      n++
      const base = at(line, t, horiz)
      for (let d = -2; d <= 2; d++) {
        const u = Math.round(base + d)
        if (horiz ? u >= 0 && u < h && e[u * w + t] : u >= 0 && u < w && e[t * w + u]) { hit++; break }
      }
    }
    return n ? hit / n : 0
  }
  const inkIn = (l: number, t: number, r: number, b: number, table = ii) => {
    const L = Math.max(0, Math.round(l)), T = Math.max(0, Math.round(t)), R = Math.min(w, Math.round(r)), B = Math.min(h, Math.round(b))
    if (R <= L || B <= T) return 0
    return table[B * (w + 1) + R]! - table[T * (w + 1) + R]! - table[B * (w + 1) + L]! + table[T * (w + 1) + L]!
  }
  let best: { score: number, t: Line, b: Line, l: Line, r: Line, cov: number, ink: number, inkAll: number } | undefined
  for (const t of H) for (const b of H) {
    const T = at(t, cx, true), B = at(b, cx, true)
    if (B - T < 0.3 * h || T > cy || B < cy) continue
    for (const l of V) for (const r of V) {
      const L = at(l, cy, false), R = at(r, cy, false)
      if (R - L < 0.3 * w || L > cx || R < cx) continue
      const cov = (coverage(t, true, L, R) + coverage(b, true, L, R) + coverage(l, false, T, B) + coverage(r, false, T, B)) / 4
      const ink = inkIn(L + 3, T + 3, R - 3, B - 3) / total
      const score = ink + 0.8 * cov
      if (!best || score > best.score) best = { score, t, b, l, r, cov, ink, inkAll: inkIn(L + 3, T + 3, R - 3, B - 3, iiAll) / Math.max(1, totalAll) }
    }
  }
  if (!best) return undefined
  const { t, b, l, r } = best
  const mask = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (y > at(t, x, true) + 2 && y < at(b, x, true) - 2 && x > at(l, y, false) + 2 && x < at(r, y, false) - 2) mask[y * w + x] = 255
  }
  // corners tl tr br bl
  const meet = (hz: Line, vt: Line): Pt => {
    const x = (vt.o + vt.s * (hz.o - hz.s * cx - cy)) / (1 - vt.s * hz.s)
    return [x, hz.o + hz.s * (x - cx)]
  }
  return { mask, cov: best.cov, corners: [meet(t, l), meet(t, r), meet(b, r), meet(b, l)], ink: best.ink, inkAll: best.inkAll }
}

// board-only max, then fill
const boardMax = (cells: Uint8Array, valid: Uint8Array, w: number, h: number): Uint8Array => {
  if (!valid.some(Boolean)) return dilate(cells, w, h, 3, 5)
  const out = new Uint8Array(cells.length)
  const done = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!valid[y * w + x]) continue
    for (let c = 0; c < 3; c++) {
      let m = 0
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const xx = x + dx, yy = y + dy
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && valid[yy * w + xx]) m = Math.max(m, cells[(yy * w + xx) * 3 + c]!)
      }
      out[(y * w + x) * 3 + c] = m
    }
    done[y * w + x] = 1
  }
  // grow outwards
  for (let changed = true; changed;) {
    changed = false
    const next = done.slice()
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (done[y * w + x]) continue
      const sum = [0, 0, 0]
      let n = 0
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const xx = x + dx, yy = y + dy
        if (xx < 0 || yy < 0 || xx >= w || yy >= h || !done[yy * w + xx]) continue
        for (let c = 0; c < 3; c++) sum[c]! += out[(yy * w + xx) * 3 + c]!
        n++
      }
      if (!n) continue
      for (let c = 0; c < 3; c++) out[(y * w + x) * 3 + c] = Math.round(sum[c]! / n)
      next[y * w + x] = 1
      changed = true
    }
    done.set(next)
  }
  return out
}

const greyOf = (rgb: Uint8Array): Uint8Array => {
  const g = new Uint8Array(rgb.length / 3)
  for (let p = 0, i = 0; p < g.length; p++, i += 3) g[p] = Math.round(lum(rgb[i]!, rgb[i + 1]!, rgb[i + 2]!))
  return g
}

// homography from[i] to to[i]
export const homography = (from: Pt[], to: Pt[]): number[] => {
  const a: number[][] = []
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i]!
    const [u, v] = to[i]!
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u])
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y, v])
  }
  // gauss-jordan
  for (let c = 0; c < 8; c++) {
    let p = c
    for (let r = c + 1; r < 8; r++) if (Math.abs(a[r]![c]!) > Math.abs(a[p]![c]!)) p = r
    ;[a[c], a[p]] = [a[p]!, a[c]!]
    const piv = a[c]![c]!
    for (let k = c; k < 9; k++) a[c]![k]! /= piv
    for (let r = 0; r < 8; r++) {
      if (r === c) continue
      const f = a[r]![c]!
      for (let k = c; k < 9; k++) a[r]![k]! -= f * a[c]![k]!
    }
  }
  return [...a.map(row => row[8]!), 1]
}

export const applyH = (m: number[], [x, y]: Pt): Pt => {
  const d = m[6]! * x + m[7]! * y + m[8]!
  return [(m[0]! * x + m[1]! * y + m[2]!) / d, (m[3]! * x + m[4]! * y + m[5]!) / d]
}

// warp quad to rectangle
export const straighten = (src: Raw, quad: Pt[], margin = 0.1): Raw => {
  const c: Pt = [quad.reduce((a, p) => a + p[0], 0) / 4, quad.reduce((a, p) => a + p[1], 0) / 4]
  // margin within photo
  let grow = margin
  for (const [x, y] of quad) {
    const dx = x - c[0], dy = y - c[1]
    if (dx > 0) grow = Math.min(grow, (src.width - 1 - c[0]) / dx - 1)
    if (dx < 0) grow = Math.min(grow, -c[0] / dx - 1)
    if (dy > 0) grow = Math.min(grow, (src.height - 1 - c[1]) / dy - 1)
    if (dy < 0) grow = Math.min(grow, -c[1] / dy - 1)
  }
  grow = Math.max(0, grow)
  const q = quad.map(([x, y]): Pt => [c[0] + (x - c[0]) * (1 + grow), c[1] + (y - c[1]) * (1 + grow)])
  const d = (a: Pt, b: Pt) => Math.hypot(a[0] - b[0], a[1] - b[1])
  let ow = Math.max(d(q[0]!, q[1]!), d(q[3]!, q[2]!))
  let oh = Math.max(d(q[0]!, q[3]!), d(q[1]!, q[2]!))
  const fit = Math.min(1, Math.max(src.width, src.height) / Math.max(ow, oh))
  ow = Math.max(1, Math.round(ow * fit))
  oh = Math.max(1, Math.round(oh * fit))
  const m = homography([[0, 0], [ow - 1, 0], [ow - 1, oh - 1], [0, oh - 1]], q)
  const out = new Uint8Array(ow * oh * 3)
  const W = src.width, H = src.height, px = src.data
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const [u, v] = applyH(m, [x, y])
    // bilinear
    const uc = Math.min(W - 1.001, Math.max(0, u)), vc = Math.min(H - 1.001, Math.max(0, v))
    const x0 = Math.floor(uc), y0 = Math.floor(vc), fx = uc - x0, fy = vc - y0
    const i00 = (y0 * W + x0) * 3, i10 = i00 + 3, i01 = i00 + W * 3, i11 = i01 + 3
    const o = (y * ow + x) * 3
    for (let k = 0; k < 3; k++) {
      out[o + k] = Math.round((px[i00 + k]! * (1 - fx) + px[i10 + k]! * fx) * (1 - fy) + (px[i01 + k]! * (1 - fx) + px[i11 + k]! * fx) * fy)
    }
  }
  return { data: out, width: ow, height: oh }
}

interface Crop {
  left: number
  top: number
  width: number
  height: number
}

// box crop
export const cropFor = (mask: Uint8Array, w: number, h: number, W: number, H: number): Crop | undefined => {
  let x0 = w, y0 = h, x1 = -1, y1 = -1
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (mask[y * w + x]! <= 127) continue
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
  }
  if (x1 < 0) return undefined
  const sx = W / w, sy = H / h, margin = 0.05 * Math.max(W, H)
  const left = Math.max(0, Math.floor(x0 * sx - margin)), top = Math.max(0, Math.floor(y0 * sy - margin))
  const right = Math.min(W, Math.ceil((x1 + 1) * sx + margin)), bottom = Math.min(H, Math.ceil((y1 + 1) * sy + margin))
  const crop = { left, top, width: right - left, height: bottom - top }
  // barely smaller
  return crop.width * crop.height > 0.92 * W * H ? undefined : crop
}

export const enhanceBoard = async (src: Raw, opts: EnhanceOptions): Promise<{ image: Raw, stats: EnhanceStats } | undefined> => {
  if (!opts.enhance && opts.crop === 'off') return undefined
  const { data: px, width: W, height: H } = src
  const raw = { raw: { width: W, height: H, channels: 3 as const } }
  const scaled = async (edge: number) => {
    const s = edge / Math.max(W, H)
    const w = Math.max(1, Math.round(W * s)), h = Math.max(1, Math.round(H * s))
    return { w, h, data: await sharp(px, raw).resize({ width: w, height: h, fit: 'fill' }).raw().toBuffer() }
  }

  const det = await scaled(800)
  const greyD = greyOf(det.data)
  const medD = await sharp(greyD, { raw: { width: det.w, height: det.h, channels: 1 } }).median(15).extractChannel(0).raw().toBuffer()

  // board polarity
  let darker = 0, brighter = 0
  for (let y = Math.floor(det.h * 0.2); y < det.h * 0.8; y++) for (let x = Math.floor(det.w * 0.2); x < det.w * 0.8; x++) {
    const d = greyD[y * det.w + x]! - medD[y * det.w + x]!
    if (d < -35) darker++
    else if (d > 35) brighter++
  }
  const light = opts.board === 'auto' ? darker >= brighter : opts.board === 'white'

  // board detection
  const colour = colourRegion(det.data, det.w, det.h)
  const frame = frameRegion(greyD, medD, det.w, det.h, light, dilate(colour, det.w, det.h, 1, 15))
  let small: Uint8Array
  let found: EnhanceStats['found']
  const count = (m: Uint8Array) => m.reduce((a, v) => a + (v > 127 ? 1 : 0), 0)
  if (frame) {
    // colour leaks past frame
    const both = count(colour) < count(frame.mask)
    small = both ? frame.mask.map((v, i) => v && colour[i]! > 127 ? 255 : 0) : frame.mask
    found = both ? 'frame+colour' : 'frame'
  } else if (count(colour) > det.w * det.h * 0.15) {
    small = colour
    found = 'colour'
  } else {
    small = new Uint8Array(det.w * det.h).fill(255)
    found = 'whole photo'
  }
  const mask = await sharp(erode(small, det.w, det.h, 1, 5), { raw: { width: det.w, height: det.h, channels: 1 } })
    .blur(2).resize({ width: W, height: H, fit: 'fill', kernel: 'cubic' }).extractChannel(0).raw().toBuffer()

  // lighting, paper-bright space
  const s64 = 64 / Math.max(W, H)
  const bw = Math.max(1, Math.round(W * s64)), bh = Math.max(1, Math.round(H * s64))
  // board cells
  const boardCell = new Uint8Array(bw * bh)
  for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
    boardCell[y * bw + x] = mask[Math.min(H - 1, Math.round((y + 0.5) * H / bh)) * W + Math.min(W - 1, Math.round((x + 0.5) * W / bw))]! > 127 ? 1 : 0
  }
  // invert grid only
  const gridOf = async (buf: Uint8Array) => {
    const cells = await sharp(buf, raw).resize({ width: bw, height: bh, fit: 'fill' }).raw().toBuffer()
    if (!light) for (let i = 0; i < cells.length; i++) cells[i] = 255 - cells[i]!
    return boardMax(cells, boardCell, bw, bh)
  }
  const grid = await gridOf(px)
  const bg = await sharp(grid, { raw: { width: bw, height: bh, channels: 3 } })
    .blur(1.5).resize({ width: W, height: H, fit: 'fill', kernel: 'cubic' }).raw().toBuffer()
  // lighting spread
  const spread = (cells: Uint8Array) => {
    const ls: number[] = []
    for (let y = 1; y < bh - 1; y++) for (let x = 1; x < bw - 1; x++) {
      const p = Math.min(H - 1, Math.round((y + 0.5) * H / bh)) * W + Math.min(W - 1, Math.round((x + 0.5) * W / bw))
      if (mask[p]! < 230) continue
      const i = (y * bw + x) * 3
      ls.push(lum(cells[i]!, cells[i + 1]!, cells[i + 2]!))
    }
    ls.sort((a, b) => a - b)
    return Math.round(pct(ls, 0.9) - pct(ls, 0.1))
  }

  // white point
  const flat = light
    ? (i: number) => Math.min(1, px[i]! / Math.max(1, bg[i]!))
    : (i: number) => Math.min(1, (255 - px[i]!) / Math.max(1, bg[i]!))
  // histograms, float samples
  const bgHist = new Uint32Array(256), boardHist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  const sampleList: number[] = []
  // sparse samples
  for (let p = 0; p < W * H; p += 29) {
    if (mask[p]! < 200) continue
    const i = p * 3
    bgHist[Math.round(lum(bg[i]!, bg[i + 1]!, bg[i + 2]!))]!++
    for (let c = 0; c < 3; c++) boardHist[c]![light ? bg[i + c]! : 255 - bg[i + c]!]!++
    const l = lum(flat(i), flat(i + 1), flat(i + 2))
    if (l > 0.5) sampleList.push(l)
  }
  const sample = Float32Array.from(sampleList).sort()
  const boardRGB = boardHist.map(hist => histPct(hist, 0.5))
  const med = pct(sample, 0.5) || 1
  const mad = pct(sample.map(v => Math.abs(v - med)).sort(), 0.5)
  const HI = opts.clean === 'off' ? 0.98 : Math.min(0.92, Math.max(0.55, med - CLEAN_MAD[opts.clean] * mad))
  const LO = HI - 0.45

  const coverage = count(small) / (det.w * det.h)
  const unevenBefore = spread(grid)
  const base: Omit<EnhanceStats, 'unevenAfter' | 'brightAfter' | 'contrastBefore' | 'contrastAfter' | 'cleaned'> = {
    label: labelOf(opts), enhanced: opts.enhance, board: light ? 'whiteboard' : 'blackboard', found, coverage, unevenBefore,
    brightBefore: Math.round(lum(boardRGB[0]!, boardRGB[1]!, boardRGB[2]!))
  }
  // already scanned
  if (opts.enhance && opts.board === 'auto' && light && unevenBefore <= 12 && histPct(bgHist, 0.5) >= 215) {
    return { image: src, stats: { ...base, skipped: true, unevenAfter: unevenBefore, brightAfter: base.brightBefore, contrastBefore: 0, contrastAfter: 0, cleaned: 0 } }
  }

  const cw = clamp01(opts.contrast)
  const lift = clamp01(opts.brightness)
  const paper = light
    ? boardRGB.map(v => (v + (255 - v) * lift) / 255)
    : boardRGB.map(v => v / 255 * (1 - 0.08 * cw))
  const sat = Math.max(0, opts.color)
  // blackboards always curve
  const gamma = light ? 1.5 : 1.5 + 0.5 * cw

  const out = new Uint8Array(px.length)
  const gapsBefore: number[] = [], gapsAfter: number[] = []
  let faint = 0, onBoard = 0
  for (let p = 0, i = 0; p < W * H; p++, i += 3) {
    const m = opts.enhance ? mask[p]! / 255 : 0
    if (m === 0) {
      out[i] = px[i]!; out[i + 1] = px[i + 1]!; out[i + 2] = px[i + 2]!
      continue
    }
    const r = flat(i), g = flat(i + 1), b = flat(i + 2)
    const l = lum(r, g, b)
    const l2 = clamp01((l - LO) / (HI - LO)) ** gamma
    // tone
    const L = Math.min(1, l / HI)
    const tone = light ? (1 - cw) * L ** 1.1 + cw * l2 : l2
    // colour, faded near paper
    const fade = light ? 1 - cw + cw * Math.min(1, (1 - l2) * 1.5) : Math.min(1, (1 - l2) * 1.5)
    for (let c = 0; c < 3; c++) {
      const v = c === 0 ? r : c === 1 ? g : b
      let e = clamp01(tone + (Math.min(1, v / HI) - L) * sat * fade)
      if (light) e *= paper[c]!
      else {
        // chalk over board
        const ink = 1 - tone
        e = paper[c]! * (1 - ink) + Math.max(1 - e, paper[c]!) * ink
      }
      out[i + c] = Math.round(255 * (m * e + (1 - m) * px[i + c]! / 255))
    }
    if (m > 0.8 && p % 23 === 0) {
      onBoard++
      // cleared
      if ((1 - l) * 255 > 10 && l >= HI) faint++
      const before = lum(px[i]!, px[i + 1]!, px[i + 2]!), after = lum(out[i]!, out[i + 1]!, out[i + 2]!)
      if (l < LO + 0.2) {
        const bgBefore = light ? lum(bg[i]!, bg[i + 1]!, bg[i + 2]!) : 255 - lum(bg[i]!, bg[i + 1]!, bg[i + 2]!)
        gapsBefore.push(Math.abs(bgBefore - before))
        gapsAfter.push(Math.abs(255 * lum(paper[0]!, paper[1]!, paper[2]!) - after))
      }
    }
  }
  gapsBefore.sort((a, b) => a - b)
  gapsAfter.sort((a, b) => a - b)
  const paperL = Math.round(255 * lum(paper[0]!, paper[1]!, paper[2]!))
  // crop
  const sx = W / det.w, sy = H / det.h
  const outside = frame && found === 'frame' ? 1 - frame.inkAll : 0
  const mayCrop = opts.crop !== 'off' && found !== 'whole photo' && outside <= MAX_OUTSIDE
  const warp = mayCrop && opts.crop === 'straighten' && found === 'frame' && frame ? straighten({ data: out, width: W, height: H }, frame.corners.map(([x, y]): Pt => [x * sx, y * sy])) : undefined
  const box = mayCrop && !warp ? cropFor(small, det.w, det.h, W, H) : undefined
  const image = warp ?? (box
    ? { data: await sharp(out, raw).extract(box).raw().toBuffer(), width: box.width, height: box.height }
    : { data: out, width: W, height: H })
  return {
    image,
    stats: {
      ...base,
      unevenAfter: spread(await gridOf(out)),
      brightAfter: paperL,
      contrastBefore: Math.round(pct(gapsBefore, 0.5)),
      contrastAfter: Math.round(pct(gapsAfter, 0.5)),
      cleaned: onBoard ? faint / onBoard : 0,
      ...warp ? { cropped: 'straightened' as const } : box ? { cropped: 'box' as const } : opts.crop !== 'off' && outside > MAX_OUTSIDE ? { outside } : {}
    }
  }
}
