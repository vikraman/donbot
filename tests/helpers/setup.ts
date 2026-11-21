import { beforeEach, afterEach, mock } from 'node:test'

import { Robot } from 'hubot'
import type { User } from 'hubot'

import { configureLines, resetLines } from '../../scripts/lib/lines.ts'
import { configurePolicy, policyFor } from '../../scripts/lib/policy.ts'
import { configureSpaces } from '../../scripts/lib/spaces.ts'
import type { Mode } from '../../scripts/lib/policy.ts'
import { setRandomSource } from '../../scripts/lib/random.ts'
import dummyRobot from '../doubles/DummyAdapter.ts'
import type { DummyAdapter } from '../doubles/DummyAdapter.ts'

// dummy adapter, maybe a fake client
export type TestRobot = Robot & { adapter: DummyAdapter & Robot['adapter'] }

export interface RobotState {
  // populated in beforeEach
  robot: TestRobot
  loadScript: () => Promise<void>
}

interface SetupOptions {
  envVars?: string[]
  deferLoad?: boolean
  // OWNER_USER_ID for the test
  owner?: string
}

// envVars restored per test; deferLoad leaves loadScript to the caller
export const setupRobot = (scriptFiles: string | string[], { envVars: vars = [], deferLoad = false, owner }: SetupOptions = {}): RobotState => {
  const envVars = owner ? [...vars, 'OWNER_USER_ID'] : vars
  const files = Array.isArray(scriptFiles) ? scriptFiles : [scriptFiles]
  // assigned in beforeEach
  const state = { robot: null, loadScript: null } as unknown as RobotState
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    process.env.EXPRESS_PORT = '0'
    // chance-based line extras off; whimsy tests opt back in
    resetLines()
    configureLines({ extras: false, casual: () => true })
    // test rooms are unplaced; casual here
    configurePolicy({ unknownMode: 'casual' })
    // unplaced rooms use the global space
    configureSpaces({ unplaced: 'global' })
    for (const name of envVars) originalEnv[name] = process.env[name]
    if (owner) process.env.OWNER_USER_ID = owner
    state.robot = new Robot(dummyRobot, true, 'Dumbotheelephant') as TestRobot
    await state.robot.loadAdapter()
    await state.robot.run()
    state.loadScript = async () => {
      for (const file of files) await state.robot.loadFile('./scripts', file)
    }
    if (!deferLoad) await state.loadScript()
  })

  afterEach(() => {
    delete process.env.EXPRESS_PORT
    for (const name of envVars) {
      if (originalEnv[name] === undefined) delete process.env[name]
      else process.env[name] = originalEnv[name]
    }
    state.robot.shutdown()
    setRandomSource(null)
    mock.reset()
  })

  return state
}

// joined strings from each robot.on(event) emission
export const collect = (robot: Robot, event: string = 'send'): string[] => {
  const messages: string[] = []
  robot.on(event, (_envelope: unknown, ...strings: string[]) => { messages.push(strings.join('')) })
  return messages
}

// sends with their room
export const collectRooms = (robot: Robot, event: string = 'send'): { room: string, text: string }[] => {
  const messages: { room: string, text: string }[] = []
  robot.on(event, (envelope: { room?: string }, ...strings: string[]) => { messages.push({ room: envelope.room ?? '', text: strings.join('') }) })
  return messages
}

export const brainUser = (robot: Robot, id: string, name: string, extra: Record<string, unknown> = {}): User =>
  robot.brain.userForId(id, { name, ...extra })

// send resolves to sent messages, like discord
export const sendReturnsIds = (robot: Robot, prefix: string) => {
  const send = robot.adapter.send.bind(robot.adapter)
  const adapter = robot.adapter as unknown as { send: (...args: Parameters<typeof send>) => Promise<unknown> }
  let next = 0
  mock.method(adapter, 'send', async (...args: Parameters<typeof send>) => {
    await send(...args)
    return [{ id: `${prefix}-${++next}` }]
  })
}

// fake guild channels, optional server mode
export const inGuild = (robot: Robot, guild: string, rooms: string[], mode?: Mode, { nsfw = false } = {}) => {
  const adapter = robot.adapter as unknown as { client?: { channels?: { cache?: Map<string, unknown> } } }
  adapter.client ??= {}
  adapter.client.channels ??= {}
  adapter.client.channels.cache ??= new Map()
  for (const room of rooms) adapter.client.channels.cache.set(room, { id: room, guildId: guild, nsfw })
  if (mode) policyFor(robot).update(d => { d.guilds[guild] = { mode, on: [], off: [] } })
}

interface ChatOptions {
  id?: string
  name?: string
  room?: string
}

interface SayOptions {
  user?: User
  room?: string
}

// default user, collected sends, say raw or ask the bot
export const chat = (state: RobotState, { id = 'test-user', name = 'test user', room = 'test-room' }: ChatOptions = {}) => {
  const { robot } = state
  const user = brainUser(robot, id, name)
  const sent = collect(robot)
  const replies = collect(robot, 'reply')
  const say = (text: string, { user: who = user, room: where = room }: SayOptions = {}) => robot.adapter.say(who, text, where)
  const ask = (text: string, opts: SayOptions = {}) => say(`@${robot.name} ${text}`, opts)
  return { robot, user, sent, replies, say, ask }
}
