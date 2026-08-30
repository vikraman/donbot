import type { MatchArray } from 'hubot'

// for groups the pattern cannot skip; throws if that is wrong
export const required = (match: MatchArray, index: number): string => {
  const value = match[index]
  if (value === undefined) throw new Error(`expected capture group ${index} to match`)
  return value
}
