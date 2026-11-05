import fs from 'node:fs'
import { createRequire } from 'node:module'

// read the bundled list directly; package api needs undeclared lodash
const require = createRequire(import.meta.url)
const dataPath = require.resolve('most-common-words-by-language/build/resources/english.txt')
const WORD_RANK = new Map<string, number>()
for (const word of fs.readFileSync(dataPath, 'utf8').split('\n').map(w => w.trim().toLowerCase()).filter(Boolean)) {
  if (!WORD_RANK.has(word)) WORD_RANK.set(word, WORD_RANK.size)
}

// 0 = most common; infinity if outside the list
export const wordRank = (word: string): number => WORD_RANK.get(word.toLowerCase()) ?? Infinity

export const isRareWord = (word: string): boolean => !WORD_RANK.has(word.toLowerCase())
