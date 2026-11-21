import { createHash } from 'node:crypto'

// ascii folding

const SYMBOLS: Record<string, string> = {
  '→': '->', '←': '<-', '↔': '<->', '⇒': '=>', '↦': '|->', '⇔': '<=>', '⟶': '-->', '⟵': '<--',
  '≡': '=', '≢': '/=', '≃': '~=', '≅': '=~', '≈': '~~', '∼': '~', '≟': '=?',
  '×': '*', '⊎': '|+|', 'Σ': 'Sigma', 'Π': 'Pi', '∥': '||', '∙': '.', '∘': '.', '⊔': '\\/',
  '≤': '<=', '≥': '>=', '¬': '~', '∀': 'forall', '∃': 'exists', 'λ': '\\',
  '⊤': 'Top', '⊥': 'Bot', '∈': '<-', '∉': '/<-', '∷': '::', '⟨': '<|', '⟩': '|>', '∞': 'inf',
  '∧': '/\\', '∨': '\\/', '⊆': '<:=', '⊂': '<:', '∪': '\\/', '∩': '/\\', '⊓': '/\\', '⋆': '*', '·': '*',
  '∣': '|', '⟦': '[[', '⟧': ']]',
  '⁻': '-', '−': '-', '′': "'", '″': "''"
}

export const ascii = (s: string): string =>
  [...s.normalize('NFKC')].map(ch => SYMBOLS[ch] ?? ch).join('')

// stable short id
export const hash = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 12)

// named module segments
export const plainModule = (m: string): string => m.split('.').filter(p => p !== '_').join('.')

// folded lowercase segments
export const segments = (m: string): string[] => ascii(plainModule(m)).toLowerCase().split('.')

// segment runs, for in:
export const segmentRuns = (m: string): string[] => {
  const segs = segments(m)
  const runs: string[] = []
  for (let i = 0; i < segs.length; i++) for (let j = i + 1; j <= segs.length; j++) runs.push(segs.slice(i, j).join('.'))
  return runs
}
