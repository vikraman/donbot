import type { Robot } from 'hubot'

import { featureById, features } from './features.ts'

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

// command in code, then description
export const formatHelpLine = (line: string): string => {
  const at = line.indexOf(' - ')
  return at < 0 ? `\`${line}\`` : `\`${line.slice(0, at)}\` – ${line.slice(at + 3)}`
}

// one line per feature
export const helpIndex = (robot: Robot, allowed: (id: string) => boolean): string[] => {
  const prefixes = helpPrefixes()
  const byFeature = new Map<string, string[]>()
  for (const line of helpLines(robot, allowed)) {
    const id = featureOfHelp(prefixes, line.replace(new RegExp(`^${robot.name}\\b`, 'i'), 'hubot'))!
    const cmd = line.split(' - ')[0]!.replace(new RegExp(`^${robot.name} `, 'i'), '')
    byFeature.set(id, [...byFeature.get(id) ?? [], cmd])
  }
  return [...byFeature]
    .map(([id, cmds]) => ({ label: featureById(id)?.label ?? id, cmds }))
    .sort((a, b) => a.label.localeCompare(b.label))
    .map(({ label, cmds }) => `**${label}**: ${cmds.map(c => `\`${c}\``).join(', ')}`)
}
