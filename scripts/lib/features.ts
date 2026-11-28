// feature registry

export type Level = 'professional' | 'casual' | 'mature'

export const LEVELS: readonly Level[] = ['professional', 'casual', 'mature']

export interface Feature {
  // dotted, e.g. joke.dark
  id: string
  label: string
  level: Level
  // reads ordinary messages
  passive?: boolean
  // for privacy
  stores?: string
  // on the web chat
  web?: boolean
  // always on
  locked?: boolean
  // off until enabled for the server
  optIn?: boolean
  // plumbing, hidden
  infra?: boolean
  // help prefixes
  help?: readonly string[]
  // help line overrides
  lines?: readonly string[]
}

const registry = new Map<string, Feature>()

// redefining replaces
export const defineFeature = (feature: Feature): Feature => {
  registry.set(feature.id, feature)
  return feature
}

export const features = (): Feature[] => [...registry.values()].sort((a, b) => a.id.localeCompare(b.id))

export const featureById = (id: string): Feature | undefined => registry.get(id)

// registered ancestors, root first
export const chainFor = (id: string): Feature[] => {
  const parts = id.split('.')
  const chain: Feature[] = []
  for (let i = 1; i <= parts.length; i++) {
    const feature = registry.get(parts.slice(0, i).join('.'))
    if (feature) chain.push(feature)
  }
  return chain
}

// most specific feature
export const featureFor = (id: string): Feature | undefined => chainFor(id).at(-1)

// external listeners by regex tail
export const EXTERNAL: readonly (readonly [string, string])[] = [
  ['(what are )?the (three |3 )?(rules|laws)', 'rules.show'],
  ['PING$', 'diagnostics.ping'],
  ['TIME$', 'diagnostics.time'],
  ['ADAPTER$', 'diagnostics.adapter'],
  ['ECHO ([\\s\\S]*)$', 'diagnostics.echo']
]

interface ListenerLike {
  options?: { id?: string | null }
  regex?: RegExp
}

export const listenerId = (listener: ListenerLike): string | null => {
  const id = listener.options?.id
  if (id) return id
  const source = listener.regex?.source ?? ''
  return EXTERNAL.find(([tail]) => source.endsWith(`(?:${tail})`))?.[1] ?? null
}

defineFeature({ id: 'rules', label: 'The three laws', level: 'professional', web: true, help: ['hubot the rules'] })
defineFeature({ id: 'diagnostics', label: 'Diagnostics', level: 'professional', web: true, help: ['hubot ping', 'hubot time'] })
defineFeature({ id: 'diagnostics.adapter', label: 'Adapter name', level: 'professional', help: ['hubot adapter'] })
defineFeature({ id: 'diagnostics.echo', label: 'Echo', level: 'casual', help: ['hubot echo'] })
