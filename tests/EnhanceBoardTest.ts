import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import sharp from 'sharp'

import { describeStats, parseEnhance, parseEnhanceSpec } from '../scripts/lib/enhance/settings.ts'
import { focusOf, hasGps, prepareImage } from '../scripts/lib/enhance/image.ts'
import { applyH, cropFor, enhanceBoard, homography, PRESETS, resolveEnhance, straighten } from '../scripts/lib/enhance/board.ts'
import type { Raw } from '../scripts/lib/enhance/board.ts'

type RGB = [number, number, number]

interface Scene {
  w: number
  h: number
  wall: RGB
  // board rect, darker rightwards
  board: [number, number, number, number]
  paper: RGB
  gradient: number
  frame?: RGB
  ink: RGB[]
}

// board on a wall
const scene = (s: Scene): Raw => {
  const data = new Uint8Array(s.w * s.h * 3)
  const set = (x: number, y: number, c: RGB) => { const i = (y * s.w + x) * 3; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2] }
  const [x0, y0, x1, y1] = s.board
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) {
    const inside = x >= x0 && x < x1 && y >= y0 && y < y1
    const f = 1 - s.gradient * (x - x0) / (x1 - x0)
    set(x, y, inside ? s.paper.map(v => Math.round(v * f)) as RGB : s.wall)
  }
  if (s.frame) {
    for (let x = x0 - 8; x < x1 + 8; x++) for (let d = 0; d < 8; d++) { set(x, y0 - 1 - d, s.frame); set(x, y1 + d, s.frame) }
    for (let y = y0 - 8; y < y1 + 8; y++) for (let d = 0; d < 8; d++) { set(x0 - 1 - d, y, s.frame); set(x1 + d, y, s.frame) }
  }
  let k = 0
  for (let y = y0 + 40; y < y1 - 40; y += 45) {
    for (let x = x0 + 40; x < x1 - 120; x += 110) {
      const ink = s.ink[k++ % s.ink.length]!
      for (let t = 0; t < 80; t++) for (let d = 0; d < 5; d++) set(x + t, y + d + Math.round(6 * Math.sin(t / 6)), ink)
    }
  }
  return { data, width: s.w, height: s.h }
}

const px = (r: Raw, x: number, y: number): RGB => {
  const i = (y * r.width + x) * 3
  return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!]
}

describe('enhance settings', () => {
  it('parses presets and settings in any combination', () => {
    assert.deepStrictEqual(parseEnhanceSpec('mild, brightness 30, clean high'), { spec: { preset: 'mild', brightness: 0.3, clean: 'high' }, errors: [] })
    assert.deepStrictEqual(parseEnhanceSpec('original').spec, { preset: 'off' })
    assert.deepStrictEqual(parseEnhanceSpec('strong, color 100, nocrop').spec, { preset: 'strong', color: 1, crop: 'off' })
    assert.deepStrictEqual(parseEnhanceSpec('off straighten').spec, { preset: 'off', crop: 'straighten' })
    assert.deepStrictEqual(parseEnhanceSpec('contrast 40 crop box blackboard clean off').spec, { contrast: 0.4, crop: 'box', board: 'black', clean: 'off' })
    // preset resets
    assert.deepStrictEqual(parseEnhanceSpec('contrast 40 strong').spec, { preset: 'strong' })
    assert.deepStrictEqual(parseEnhanceSpec('brightness 150 sparkly color 300').errors, ['brightness takes 0-100', 'I don\'t know "sparkly"', 'color takes 0-200'])
  })

  it('resolves channel and message settings, a preset resetting the ones before', () => {
    assert.deepStrictEqual(resolveEnhance(), PRESETS.mild)
    assert.deepStrictEqual(resolveEnhance({ preset: 'strong', clean: 'high' }, { brightness: 0.3 }), { ...PRESETS.strong, clean: 'high', brightness: 0.3 })
    assert.deepStrictEqual(resolveEnhance({ preset: 'strong', clean: 'high' }, { preset: 'mild', crop: 'off' }), { ...PRESETS.mild, crop: 'off' })
  })

  it('takes enhance lines out of the caption', () => {
    assert.deepStrictEqual(parseEnhance('Monday board\nenhance: strong\nmore text'), { body: 'Monday board\nmore text', spec: { preset: 'strong' }, errors: [] })
    assert.deepStrictEqual(parseEnhance('no settings'), { body: 'no settings', errors: [] })
  })

  it('describes what changed in one terse line', () => {
    const line = describeStats({
      inWidth: 4032, inHeight: 3024, inBytes: 3_500_000, outBytes: 255_000, metadata: 'location',
      enhance: { label: 'mild', enhanced: true, board: 'whiteboard', found: 'frame', coverage: 0.69, unevenBefore: 38, unevenAfter: 8, brightBefore: 203, brightAfter: 229, contrastBefore: 152, contrastAfter: 165, cleaned: 0.24, cropped: 'straightened' }
    }, { width: 1821, height: 1322 })
    assert.strictEqual(line, 'mild whiteboard · board 69% · light 38→8 · bright 203→229 · contrast 152→165 · cleaned 24% · straightened · 4032×3024→1821×1322 · 3.5MB→255KB · GPS removed')
    assert.strictEqual(describeStats({ inWidth: 800, inHeight: 600, inBytes: 90_000, outBytes: 80_000, metadata: 'none' }, { width: 800, height: 600 }), 'not enhanced · 90KB→80KB')
  })

  it('crops to the board with a margin, and not when it would barely change', () => {
    const mask = new Uint8Array(100 * 100)
    for (let y = 20; y < 70; y++) for (let x = 10; x < 90; x++) mask[y * 100 + x] = 255
    assert.deepStrictEqual(cropFor(mask, 100, 100, 1000, 1000), { left: 50, top: 150, width: 900, height: 600 })
    assert.strictEqual(cropFor(new Uint8Array(100 * 100).fill(255), 100, 100, 1000, 1000), undefined)
    assert.deepStrictEqual(parseEnhanceSpec('strong crop').spec, { preset: 'strong', crop: 'straighten' })
  })

  it('maps corners with a homography and straightens a slanted quad', () => {
    const from: [number, number][] = [[0, 0], [99, 0], [99, 49], [0, 49]]
    const to: [number, number][] = [[10, 20], [180, 5], [190, 140], [5, 120]]
    const m = homography(from, to)
    for (let i = 0; i < 4; i++) {
      const [u, v] = applyH(m, from[i]!)
      assert.ok(Math.abs(u - to[i]![0]) < 1e-6 && Math.abs(v - to[i]![1]) < 1e-6)
    }
    // red quad on blue
    const W = 200, H = 150, data = new Uint8Array(W * H * 3)
    const quad: [number, number][] = [[30, 30], [170, 15], [180, 130], [20, 120]]
    const inside = (x: number, y: number) => quad.every((p, i) => {
      const q = quad[(i + 1) % 4]!
      return (q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]) >= 0
    })
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(inside(x, y) ? [220, 20, 20] : [20, 20, 220], (y * W + x) * 3)
    const out = straighten({ data, width: W, height: H }, quad, 0)
    let red = 0
    for (let i = 0; i < out.data.length; i += 3) if (out.data[i]! > out.data[i + 2]!) red++
    assert.ok(red / (out.width * out.height) > 0.97, `${red / (out.width * out.height)}`)
    assert.ok(out.width > out.height)
  })

})

describe('board enhancement', () => {
  it('evens a framed whiteboard, keeps ink colours and leaves the wall alone', async () => {
    const src = scene({ w: 1600, h: 1200, wall: [232, 214, 178], board: [200, 150, 1400, 1050], paper: [215, 212, 204], gradient: 0.25, frame: [120, 120, 125], ink: [[30, 40, 140], [180, 30, 40], [25, 25, 30]] })
    const result = await enhanceBoard(src, { ...PRESETS.mild, crop: 'off' })
    assert.ok(result)
    const { image, stats } = result
    assert.strictEqual(stats.board, 'whiteboard')
    assert.match(stats.found, /frame/)
    // wall untouched
    for (const [x, y] of [[20, 20], [1580, 600], [800, 1180], [100, 1100]] as const) assert.deepStrictEqual(px(image, x, y), px(src, x, y))
    // even lighting
    const left = px(image, 230, 600), right = px(image, 1370, 600)
    assert.ok(Math.abs(left[0] - right[0]) <= 6, `${left.join()} vs ${right.join()}`)
    assert.ok(stats.unevenAfter < stats.unevenBefore)
    // inks keep hue
    const blue = px(image, 241, 192), red = px(image, 351, 192)
    assert.ok(blue[2] > blue[0] + 40, `blue ${blue.join()}`)
    assert.ok(red[0] > red[2] + 40, `red ${red.join()}`)
  })

  it('keeps a chalkboard\'s colour and its chalk bright', async () => {
    const src = scene({ w: 1600, h: 1200, wall: [200, 190, 170], board: [150, 120, 1450, 1080], paper: [50, 95, 75], gradient: 0.3, frame: [140, 100, 70], ink: [[235, 235, 225], [240, 230, 120]] })
    const result = await enhanceBoard(src, { ...PRESETS.mild, crop: 'off' })
    assert.ok(result)
    const { image, stats } = result
    assert.strictEqual(stats.board, 'blackboard')
    assert.deepStrictEqual(px(image, 20, 20), px(src, 20, 20))
    const board = px(image, 170, 600), chalk = px(image, 191, 162)
    // green board, bright chalk
    assert.ok(board[1] > board[0] && board[1] > board[2], `board ${board.join()}`)
    assert.ok(chalk[0] > board[0] + 100, `chalk ${chalk.join()} board ${board.join()}`)
  })

  it('leaves scanner-app output alone, and does nothing when off', async () => {
    const src = scene({ w: 1200, h: 800, wall: [226, 226, 226], board: [0, 0, 1200, 800], paper: [226, 226, 226], gradient: 0, ink: [[20, 30, 120]] })
    const result = await enhanceBoard(src, { ...PRESETS.mild, crop: 'off' })
    assert.ok(result?.stats.skipped)
    assert.strictEqual(result.image, src)
    assert.strictEqual(await enhanceBoard(src, PRESETS.off), undefined)
  })
})

describe('images', () => {
  // ink top-left
  const board = (bg: number, ink: number) => Uint8Array.from({ length: 100 }, (_v, i) => i % 10 < 3 && i < 30 ? ink : bg)

  it('centres the focal point on the ink, on white and black boards', () => {
    for (const grey of [board(240, 20), board(30, 230)]) {
      const f = focusOf(grey, 10, 10)
      assert.ok(f.x < -0.5 && f.y > 0.5, JSON.stringify(f))
    }
    assert.deepStrictEqual(focusOf(new Uint8Array(100).fill(200), 10, 10), { x: 0, y: 0 })
  })

  it('strips metadata, resizes and fits the byte limit', async () => {
    const input = await sharp({ create: { width: 4000, height: 3000, channels: 3, background: '#808080', noise: { type: 'gaussian', mean: 128, sigma: 60 } } })
      .jpeg().withExif({ IFD0: { Copyright: 'lab' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '51/1 30/1 0/1' } }).toBuffer()
    const out = await prepareImage(new Uint8Array(input), 976_560)
    assert.strictEqual(out.stats?.metadata, 'location')
    assert.ok(out.data.length <= 976_560)
    assert.ok(Math.max(out.width, out.height) <= 2000)
    const text = Buffer.from(out.data).toString('latin1')
    assert.ok(!text.includes('Exif') && !text.includes('lab'))
    assert.ok(out.focus && Math.abs(out.focus.x) <= 1 && Math.abs(out.focus.y) <= 1)
  })
})

describe('exif', () => {
  it('finds a gps block only in the ifd0 tag table', async () => {
    const withGps = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().withExif({ IFD3: { GPSLatitudeRef: 'N' } }).toBuffer()
    const without = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#fff' } }).jpeg().withExif({ IFD0: { Copyright: '\x88\x25 \x25\x88' } }).toBuffer()
    assert.ok(hasGps((await sharp(withGps).metadata()).exif))
    assert.ok(!hasGps((await sharp(without).metadata()).exif))
    // stray bytes
    assert.ok(!hasGps(Buffer.from([0x4d, 0x4d, 0x88, 0x25, 0, 4])))
    assert.ok(!hasGps(undefined))
  })
})
