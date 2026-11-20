import type { Robot } from 'hubot'

import { features } from './features.ts'

// help by feature, longest prefix wins
export const helpLines = (robot: Robot, allowed: (id: string) => boolean, query?: string): string[] => {
  const prefixes = helpPrefixes()
  return robot.helpCommands()
    .filter(line => {
      const owner = featureOfHelp(prefixes, line)
      return Boolean(owner && allowed(owner))
    })
    .map(line => line.replace(/\bhubot\b/gi, robot.name))
    .filter(line => !query || line.toLowerCase().includes(query.toLowerCase()))
}

export const featureOfHelp = (prefixes: readonly (readonly [string, string])[], line: string): string | undefined => {
  const lower = line.toLowerCase()
  return prefixes.filter(([p]) => lower.startsWith(p)).sort((a, b) => b[0].length - a[0].length)[0]?.[1]
}

export const helpPrefixes = (): (readonly [string, string])[] =>
  features().flatMap(f => (f.help ?? []).map(p => [p.toLowerCase(), f.id] as const))
