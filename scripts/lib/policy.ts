import type { Response, Robot } from 'hubot'

import { chainFor, type Feature } from './features.ts'
import { isWebRoom } from './web.ts'

// per-scope modes and overrides

export type Mode = 'professional' | 'casual'

export interface Rec {
  mode?: Mode
  on: string[]
  off: string[]
  by?: string
  at?: number
}

export interface PolicyData {
  v: 1
  guilds: Record<string, Rec>
  channels: Record<string, Rec>
  // keyed by user id
  dms: Record<string, Rec>
}

export type ScopeKind = 'web' | 'dm' | 'guild' | 'unknown'

export interface Scope {
  kind: ScopeKind
  room: string
  // parent for threads
  channel?: string
  guild?: string
  user?: string
  nsfw?: boolean
}

interface Resolved {
  scope: Scope
  mode: Mode
  // most specific first
  layers: Rec[]
  passiveOn: boolean
  // server off is final
  serverOff?: string[]
  serverOn?: string[]
}

export interface ChannelLike {
  id?: string
  guildId?: string | null
  parentId?: string | null
  parent?: ChannelLike | null
  nsfw?: boolean
  recipientId?: string
  isThread?: () => boolean
  isDMBased?: () => boolean
}

export interface RawLike {
  guildId?: string | null
  author?: { id?: string }
  channel?: ChannelLike
}

export const POLICY_KEY = 'policy'

const empty = (): PolicyData => ({ v: 1, guilds: {}, channels: {}, dms: {} })

const isRec = (value: unknown): value is Rec =>
  typeof value === 'object' && value !== null && Array.isArray((value as Rec).on) && Array.isArray((value as Rec).off)

const cleanRecs = (value: unknown): Record<string, Rec> =>
  typeof value === 'object' && value !== null
    ? Object.fromEntries(Object.entries(value).filter(([, rec]) => isRec(rec)))
    : {}

// unplaced rooms
let unknownMode: Mode = 'professional'
export const configurePolicy = (options: { unknownMode?: Mode }) => {
  if (options.unknownMode) unknownMode = options.unknownMode
}

export const allowsFeature = (resolved: Resolved, feature: Feature): boolean => {
  // web: offered features only
  if (resolved.scope.kind === 'web') return feature.level === 'professional' && Boolean(feature.web) && !feature.passive && !feature.infra
  if (feature.infra || feature.locked) return true
  if (resolved.serverOff?.includes(feature.id)) return false
  // opt-in: server on, channel off wins
  if (feature.optIn) {
    if (resolved.scope.kind !== 'guild' || !resolved.serverOn?.includes(feature.id)) return false
    return !resolved.layers.some(rec => rec.off.includes(feature.id))
  }
  // mature needs nsfw, checked on use
  if (feature.level === 'mature' && resolved.scope.kind === 'guild' && !resolved.scope.nsfw) return false
  for (const rec of resolved.layers) {
    if (rec.off.includes(feature.id)) return false
    if (rec.on.includes(feature.id)) return true
  }
  if (feature.level === 'mature') return false
  if (feature.passive) return resolved.passiveOn
  return feature.level === 'professional' || resolved.mode === 'casual'
}

export interface Policy {
  scopeOf: (room: string, raw?: RawLike) => Scope
  allows: (res: Response, id: string) => boolean
  allowsRoom: (room: string, id: string) => boolean
  allowsRoomAsync: (room: string, id: string) => Promise<boolean>
  // first blocked in chain
  blockedBy: (res: Response, id: string) => Feature | undefined
  modeOf: (room: string, raw?: RawLike) => Mode
  resolve: (room: string, raw?: RawLike) => Resolved
  data: () => PolicyData
  update: (change: (data: PolicyData) => void) => void
}

const policies = new WeakMap<Robot, Policy>()

const channelOf = (channel: ChannelLike, fallback: string): { channel: string, nsfw?: boolean } => {
  if (channel.isThread?.()) return { channel: channel.parentId ?? channel.id ?? fallback, nsfw: channel.parent?.nsfw }
  return { channel: channel.id ?? fallback, nsfw: channel.nsfw }
}

export const policyFor = (robot: Robot): Policy => {
  const existing = policies.get(robot)
  if (existing) return existing

  // parsed data only
  let cached: PolicyData | undefined
  // many connected handlers
  robot.brain.setMaxListeners(Math.max(robot.brain.getMaxListeners(), 30))
  robot.brain.on('connected', () => { cached = undefined })

  const data = (): PolicyData => {
    if (cached) return cached
    const stored = robot.brain.get<Partial<PolicyData>>(POLICY_KEY)
    cached = !stored || typeof stored !== 'object'
      ? empty()
      : { v: 1, guilds: cleanRecs(stored.guilds), channels: cleanRecs(stored.channels), dms: cleanRecs(stored.dms) }
    return cached
  }

  const update = (change: (d: PolicyData) => void) => {
    const d = structuredClone(data())
    change(d)
    robot.brain.set(POLICY_KEY, d)
    cached = undefined
  }

  const cachedChannel = (room: string): ChannelLike | undefined => {
    const channels = robot.adapter?.client?.channels?.cache as Map<string, ChannelLike> | undefined
    return channels?.get(room)
  }

  const scopeOf = (room: string, raw?: RawLike): Scope => {
    if (isWebRoom(room)) return { kind: 'web', room }
    // discord.js sets guildId to null in dms
    if (raw?.guildId === null) return { kind: 'dm', room, user: raw.author?.id }
    if (typeof raw?.guildId === 'string') return { kind: 'guild', room, guild: raw.guildId, ...(raw.channel ? channelOf(raw.channel, room) : { channel: room }) }
    const channel = cachedChannel(room)
    if (channel?.guildId) return { kind: 'guild', room, guild: channel.guildId, ...channelOf(channel, room) }
    if (channel?.isDMBased?.()) return { kind: 'dm', room, user: channel.recipientId }
    return { kind: 'unknown', room }
  }

  const resolve = (room: string, raw?: RawLike): Resolved => {
    const scope = scopeOf(room, raw)
    const d = data()
    if (scope.kind === 'dm') {
      const rec = scope.user ? d.dms[scope.user] : undefined
      return { scope, mode: rec?.mode ?? 'casual', layers: rec ? [rec] : [], passiveOn: false }
    }
    if (scope.kind === 'guild') {
      const layers = [d.channels[scope.channel!], d.guilds[scope.guild!]].filter((r): r is Rec => Boolean(r))
      const mode = layers.find(r => r.mode)?.mode ?? 'professional'
      return { scope, mode, layers, passiveOn: mode === 'casual', serverOff: d.guilds[scope.guild!]?.off, serverOn: d.guilds[scope.guild!]?.on }
    }
    const mode = scope.kind === 'web' ? 'professional' : unknownMode
    return { scope, mode, layers: [], passiveOn: mode === 'casual' }
  }

  const rawOf = (res: Response): RawLike | undefined => res.message.user?.message as RawLike | undefined

  const blockedIn = (resolved: Resolved, id: string): Feature | undefined => {
    const chain = chainFor(id)
    // unregistered: blocked
    if (chain.length === 0) return { id, label: id, level: 'mature' }
    return chain.find(f => !allowsFeature(resolved, f))
  }

  const policy: Policy = {
    scopeOf,
    resolve,
    data,
    update,
    allows: (res, id) => !blockedIn(resolve(res.message.room, rawOf(res)), id),
    allowsRoom: (room, id) => !blockedIn(resolve(room), id),
    allowsRoomAsync: async (room, id) => {
      if (!isWebRoom(room) && !cachedChannel(room)) {
        // dms aren't cached after a restart
        try { await robot.adapter?.client?.channels?.fetch?.(room) } catch {}
      }
      return !blockedIn(resolve(room), id)
    },
    blockedBy: (res, id) => blockedIn(resolve(res.message.room, rawOf(res)), id),
    modeOf: (room, raw) => resolve(room, raw).mode
  }
  policies.set(robot, policy)
  return policy
}

// shorthands for scripts
export const allows = (robot: Robot, res: Response, id: string): boolean => policyFor(robot).allows(res, id)
export const allowsRoom = (robot: Robot, room: string, id: string): boolean => policyFor(robot).allowsRoom(room, id)
export const allowsRoomAsync = (robot: Robot, room: string, id: string): Promise<boolean> => policyFor(robot).allowsRoomAsync(room, id)
