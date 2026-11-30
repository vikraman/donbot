// enhance settings and stats

import type { BoardKind, Clean, CropMode, EnhanceSpec, Preset } from './board.ts'
import type { ImageStats } from './image.ts'

const PRESET_WORDS: Record<string, Preset> = {
  mild: 'mild', on: 'mild', yes: 'mild', soft: 'mild', default: 'mild',
  strong: 'strong', white: 'strong', max: 'strong', scan: 'strong',
  off: 'off', none: 'off', no: 'off', original: 'off', raw: 'off'
}
const CLEAN_WORDS: Record<string, Clean> = { off: 'off', none: 'off', low: 'low', less: 'low', normal: 'normal', high: 'high', more: 'high' }
const CROP_WORDS: Record<string, CropMode> = { off: 'off', none: 'off', no: 'off', box: 'box', straighten: 'straighten', on: 'straighten', yes: 'straighten' }
const BOARD_WORDS: Record<string, BoardKind> = { auto: 'auto', white: 'white', black: 'black', chalk: 'black', green: 'black' }
// one-word settings
const FLAGS: Record<string, EnhanceSpec> = {
  crop: { crop: 'straighten' }, straighten: { crop: 'straighten' }, box: { crop: 'box' },
  nocrop: { crop: 'off' }, uncropped: { crop: 'off' }, full: { crop: 'off' },
  whiteboard: { board: 'white' }, blackboard: { board: 'black' }, chalkboard: { board: 'black' }
}
const NUMBERS: Record<string, ['brightness' | 'contrast' | 'color', number]> = {
  brightness: ['brightness', 100], bright: ['brightness', 100], lift: ['brightness', 100],
  contrast: ['contrast', 100],
  color: ['color', 200], colour: ['color', 200], colors: ['color', 200], colours: ['color', 200], saturation: ['color', 200], sat: ['color', 200]
}

// enhance settings
export const parseEnhanceSpec = (text: string): { spec: EnhanceSpec, errors: string[] } => {
  const out: EnhanceSpec = {}
  const errors: string[] = []
  const words = text.toLowerCase().split(/[\s,;]+/).filter(Boolean)
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const number = NUMBERS[w]
    if (PRESET_WORDS[w]) {
      // preset resets
      for (const k of Object.keys(out)) delete out[k as keyof EnhanceSpec]
      out.preset = PRESET_WORDS[w]
    } else if (number) {
      const [key, max] = number
      const n = Number(words[++i]?.replace(/%$/, ''))
      if (Number.isFinite(n) && n >= 0 && n <= max) out[key] = n / 100
      else errors.push(`${key} takes 0-${max}`)
    } else if (w === 'clean' || w === 'cleanup') {
      const c = CLEAN_WORDS[words[++i] ?? '']
      if (c) out.clean = c
      else errors.push('clean takes off, low, normal or high')
    } else if (w === 'crop' && CROP_WORDS[words[i + 1] ?? '']) {
      out.crop = CROP_WORDS[words[++i]!]
    } else if (w === 'board' || w === 'type') {
      const b = BOARD_WORDS[words[++i] ?? '']
      if (b) out.board = b
      else errors.push('board takes auto, white or black')
    } else if (FLAGS[w]) Object.assign(out, FLAGS[w])
    else errors.push(`I don't know "${w}"`)
  }
  return { spec: out, errors }
}

// help text
export const ENHANCE_HELP = 'mild|strong|off, brightness 0-100, contrast 0-100, color 0-200, clean off|low|normal|high, straighten|box|nocrop, whiteboard|blackboard'

const ENHANCE_LINE = /^\s*enhance(?:ment)?\s*:\s*(.*?)\s*$/i

// enhance lines, last wins
export const parseEnhance = (text: string): { body: string, spec?: EnhanceSpec, errors: string[] } => {
  let spec: EnhanceSpec | undefined
  let errors: string[] = []
  const body: string[] = []
  for (const line of text.split('\n')) {
    const m = ENHANCE_LINE.exec(line)
    if (!m) {
      body.push(line)
      continue
    }
    const parsed = parseEnhanceSpec(m[1]!)
    spec = parsed.spec
    errors = parsed.errors
  }
  return { body: body.join('\n').trim(), ...spec ? { spec } : {}, errors }
}

const sizeOf = (n: number): string => n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : n >= 1e3 ? `${Math.round(n / 1e3)}KB` : `${n}B`
const percent = (f: number): string => `${Math.round(f * 100)}%`

// stats line
export const describeStats = (s: ImageStats, size: { width: number, height: number }): string => {
  const parts: string[] = []
  const e = s.enhance
  if (!e || !e.enhanced) parts.push('not enhanced')
  else if (e.skipped) parts.push('already scanned')
  else {
    parts.push(`${e.label} ${e.board}`, `board ${percent(e.coverage)}${e.found === 'frame' ? '' : ` (${e.found})`}`, `light ${e.unevenBefore}→${e.unevenAfter}`)
    if (e.brightAfter !== e.brightBefore) parts.push(`bright ${e.brightBefore}→${e.brightAfter}`)
    parts.push(`contrast ${e.contrastBefore}→${e.contrastAfter}`)
    if (e.cleaned >= 0.01) parts.push(`cleaned ${percent(e.cleaned)}`)
  }
  if (e?.cropped) parts.push(e.cropped === 'straightened' ? 'straightened' : 'cropped')
  else if (e?.outside) parts.push(`uncropped (${percent(e.outside)} of writing off board)`)
  if (s.inWidth !== size.width || s.inHeight !== size.height) parts.push(`${s.inWidth}×${s.inHeight}→${size.width}×${size.height}`)
  parts.push(`${sizeOf(s.inBytes)}→${sizeOf(s.outBytes)}`)
  if (s.metadata !== 'none') parts.push(s.metadata === 'location' ? 'GPS removed' : 'EXIF removed')
  return parts.join(' · ')
}
