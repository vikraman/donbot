// targets, overridable in tests

import { blueskyTarget } from './bluesky.ts'
import { mastodonTarget } from './mastodon.ts'
import type { Visibility } from './mastodon.ts'
import type { Target, TargetId } from './types.ts'

const VISIBILITY: readonly Visibility[] = ['public', 'unlisted', 'private']

// env targets, cached
const cache = new Map<string, Target>()

const cached = (key: string, make: () => Target): Target => {
  let target = cache.get(key)
  if (!target) {
    target = make()
    cache.set(key, target)
  }
  return target
}

const fromEnv = (): Partial<Record<TargetId, Target>> => {
  const env = process.env
  const found: Partial<Record<TargetId, Target>> = {}
  if (env.MASTODON_URL && env.MASTODON_TOKEN) {
    const visibility = VISIBILITY.find(v => v === env.SOCIAL_VISIBILITY) ?? 'public'
    const base = env.MASTODON_URL
    const token = env.MASTODON_TOKEN
    found.mastodon = cached(`m|${base}|${token}|${visibility}`, () => mastodonTarget({ base, token, visibility }))
  }
  if (env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD) {
    const handle = env.BLUESKY_HANDLE
    const password = env.BLUESKY_APP_PASSWORD
    const service = env.BLUESKY_SERVICE || undefined
    found.bluesky = cached(`b|${handle}|${password}|${service ?? ''}`, () => blueskyTarget({ handle, password, service }))
  }
  return found
}

interface Config {
  targets?: () => Partial<Record<TargetId, Target>>
}

let config: Config = {}

export const configureSocial = (next: Config) => { config = next }

export const configuredTargets = (): Partial<Record<TargetId, Target>> => (config.targets ?? fromEnv)()
