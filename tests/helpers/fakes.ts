import { mock } from 'node:test'
import { EventEmitter } from 'node:events'

import type { Robot, User } from 'hubot'

import type { RobotState } from './setup.ts'

// let pending handlers run
export const settle = () => new Promise(resolve => setImmediate(resolve))

export const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))

// make a scheduled job due now and re-arm it
export const runDueJobs = async (robot: Robot, name: string, ms = 30) => {
  const jobs = robot.brain.get<{ at: number }[]>(`schedule:${name}`) ?? []
  robot.brain.set(`schedule:${name}`, jobs.map(j => ({ ...j, at: Date.now() })))
  robot.brain.emit('connected')
  await tick(ms)
}

// fake discord client on the adapter, then load the script
export const fakeClient = async <T extends object>(state: RobotState, extra: T = {} as T): Promise<EventEmitter & T> => {
  const client = Object.assign(new EventEmitter(), extra)
  state.robot.adapter.client = client
  await state.loadScript()
  return client
}

interface ReactOptions {
  room?: string
  author?: string
  bot?: boolean
  by?: string
  message?: Record<string, unknown>
  user?: Record<string, unknown>
}

// emit a reaction add from a fake client
export const react = async (client: EventEmitter, emoji: string, { room = 'room-1', author = 'alice', bot = false, by = 'bob', message = {}, user = {} }: ReactOptions = {}) => {
  const reaction = { partial: false, emoji: { name: emoji }, message: { channelId: room, author: { username: author }, ...message } }
  client.emit('messageReactionAdd', reaction, { bot, username: by, ...user })
  await settle()
}

export interface RawOptions {
  guild?: string | null
  manageGuild?: boolean
  manageChannels?: boolean
  nsfw?: boolean
  // thread inside this channel
  parent?: string
}

// fake discord.js message
export const discordMessage = (room: string, user: string, { guild = 'g1', manageGuild = false, manageChannels = false, nsfw = false, parent }: RawOptions = {}) => {
  const perms = (channelLevel: boolean) => ({ has: (flag: string) => flag === 'ManageGuild' ? manageGuild : flag === 'ManageChannels' ? channelLevel : false })
  const member = { permissions: perms(false) }
  const channel = parent
    ? { id: room, parentId: parent, parent: { id: parent, nsfw }, isThread: () => true, permissionsFor: () => perms(manageChannels) }
    : { id: room, nsfw, isThread: () => false, permissionsFor: () => perms(manageChannels) }
  return { guildId: guild, author: { id: user }, member: guild ? member : null, channel }
}

// attach a raw message to a user
export const withMessage = (user: User, message: unknown): User => {
  (user as unknown as { message: unknown }).message = message
  return user
}

// json body, or a function of url and init
type FetchReply = unknown

export interface FetchOptions {
  ok?: boolean
  status?: number
}

// fetch double resolving json; returns requested urls
export const mockFetch = (reply: FetchReply, { ok = true, status = ok ? 200 : 500 }: FetchOptions = {}): string[] => {
  const urls: string[] = []
  mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    urls.push(String(url))
    const body = typeof reply === 'function' ? await (reply as (u: string, i?: RequestInit) => unknown)(String(url), init) : reply
    return { ok, status, json: async () => body, text: async () => typeof body === 'string' ? body : JSON.stringify(body) }
  })
  return urls
}

export const geminiBody = (text: unknown) => ({ candidates: [{ content: { parts: [{ text: typeof text === 'string' ? text : JSON.stringify(text) }] } }] })

// gemini generateContent reply
export const mockGemini = (text: unknown) => mockFetch(geminiBody(text))

// mutable Date.now
export const clock = (start = Date.now()) => {
  let now = start
  mock.method(Date, 'now', () => now)
  return {
    get now () { return now },
    set: (ms: number) => { now = ms },
    advance: (ms: number) => { now += ms }
  }
}

// set env vars for fn, then restore
export const withEnv = async <T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> => {
  const saved = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]))
  const apply = (v: Record<string, string | undefined>) => {
    for (const [k, val] of Object.entries(v)) {
      if (val === undefined) delete process.env[k]
      else process.env[k] = val
    }
  }
  apply(vars)
  try { return await fn() } finally { apply(saved) }
}
