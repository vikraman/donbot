import type { Response, Robot } from 'hubot'

import { entriesWithPrefix } from './brainScan.ts'
import { policyFor, type RawLike, type Scope } from './policy.ts'

// data partitions: g:<guild>, dm:<user>, web, room:<room>, '' legacy global
// room-keyed data needs no space

export type SpaceId = string

export interface Member {
  name: string
  // only where seen is on
  seen?: number
}

const MEMBERS = 'members'

interface SpaceOptions {
  // room, or global for tests
  unplaced?: 'room' | 'global'
  // custom mapping, e.g. linked servers
  resolve?: (scope: Scope) => SpaceId | undefined
}

let options: Required<Pick<SpaceOptions, 'unplaced'>> & SpaceOptions = { unplaced: 'room' }
export const configureSpaces = (next: SpaceOptions) => { options = { ...options, ...next } }

export const spaceOfScope = (scope: Scope): SpaceId => {
  const custom = options.resolve?.(scope)
  if (custom !== undefined) return custom
  switch (scope.kind) {
    case 'web': return 'web'
    case 'guild': return `g:${scope.guild}`
    case 'dm': return scope.user ? `dm:${scope.user}` : `room:${scope.room}`
    default: return options.unplaced === 'global' ? '' : `room:${scope.room}`
  }
}

export const spaceOf = (robot: Robot, room: string, raw?: RawLike): SpaceId => spaceOfScope(policyFor(robot).scopeOf(room, raw))

export const spaceOfRes = (robot: Robot, res: Response): SpaceId =>
  spaceOf(robot, res.message.room, res.message.user?.message as RawLike | undefined)

export interface SpaceStore {
  space: SpaceId
  key: (key: string) => string
  get: <T = unknown>(key: string) => T | null
  set: (key: string, value: unknown) => void
  remove: (key: string) => void
  entries: <T>(prefix: string, isValid?: (value: unknown) => value is T) => [string, T][]
}

// key layout
export const spaceKey = (space: SpaceId, key: string): string => space ? `${space}:${key}` : key

export const storeFor = (robot: Robot, space: SpaceId): SpaceStore => ({
  space,
  key: key => spaceKey(space, key),
  get: <T>(key: string) => (robot.brain.get<T>(spaceKey(space, key)) ?? null) as T | null,
  set: (key, value) => robot.brain.set(spaceKey(space, key), value),
  remove: key => robot.brain.remove(spaceKey(space, key)),
  entries: (prefix, isValid) => entriesWithPrefix(robot, spaceKey(space, prefix), isValid)
})

export const storeOf = (robot: Robot, res: Response): SpaceStore => storeFor(robot, spaceOfRes(robot, res))

const isMembers = (value: unknown): value is Record<string, Member> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const membersOf = (robot: Robot, space: SpaceId): Record<string, Member> => {
  const stored = robot.brain.get(spaceKey(space, MEMBERS))
  const members = isMembers(stored) ? stored : {}
  if (space) return members
  // global space knows all brain users
  const everyone = Object.fromEntries(Object.values(robot.brain.data.users || {}).filter(u => u.name).map(u => [String(u.id), { name: u.name }]))
  return { ...everyone, ...members }
}

export const learnMember = (robot: Robot, space: SpaceId, id: string, name: string, seen?: number) => {
  const stored = robot.brain.get(spaceKey(space, MEMBERS))
  const members = isMembers(stored) ? stored : {}
  const old = members[id]
  if (old?.name === name && seen === undefined) return
  robot.brain.set(spaceKey(space, MEMBERS), { ...members, [id]: { ...old, name, ...(seen !== undefined && { seen }) } })
}

export interface Person {
  id: string
  name: string
}

// usersForFuzzyName within a space
export const findPeople = (robot: Robot, space: SpaceId, fuzzy: string): Person[] => {
  const lower = fuzzy.toLowerCase()
  const matches = Object.entries(membersOf(robot, space))
    .filter(([, m]) => m.name.toLowerCase().startsWith(lower))
    .map(([id, m]) => ({ id, name: m.name }))
  const exact = matches.find(p => p.name.toLowerCase() === lower)
  return exact ? [exact] : matches
}

export const peopleFor = (robot: Robot, res: Response, fuzzy: string): Person[] => findPeople(robot, spaceOfRes(robot, res), fuzzy)

// exact name, any case
export const personNamed = (robot: Robot, space: SpaceId, name: string): Person[] =>
  Object.entries(membersOf(robot, space)).filter(([, m]) => m.name.toLowerCase() === name.toLowerCase()).map(([id, m]) => ({ id, name: m.name }))
