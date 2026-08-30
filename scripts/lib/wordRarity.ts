import fs from 'node:fs'
import { createRequire } from 'node:module'

// read the bundled list directly; package api needs undeclared lodash
const require = createRequire(import.meta.url)
const dataPath = require.resolve('most-common-words-by-language/build/resources/english.txt')
const COMMON_WORDS = new Set(
  fs.readFileSync(dataPath, 'utf8').split('\n').map(w => w.trim().toLowerCase()).filter(Boolean)
)

export const isRareWord = (word: string): boolean => !COMMON_WORDS.has(word.toLowerCase())
