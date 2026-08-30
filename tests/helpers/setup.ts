import { beforeEach, afterEach, mock } from 'node:test'

import { Robot } from 'hubot'
import type { User } from 'hubot'

import { setRandomSource } from '../../scripts/lib/random.ts'
import dummyRobot from '../doubles/DummyAdapter.ts'
import type { DummyAdapter } from '../doubles/DummyAdapter.ts'

// the dummy adapter, plus any fake discord client a script hangs off it
export type TestRobot = Robot & { adapter: DummyAdapter & Robot['adapter'] }

export interface RobotState {
  // populated in beforeEach
  robot: TestRobot
  loadScript: () => Promise<void>
}

interface SetupOptions {
  envVars?: string[]
  deferLoad?: boolean
}

// shared robot bootstrap; envVars restored per test
// deferLoad: caller runs loadScript() after setting adapter.client
export const setupRobot = (scriptFiles: string | string[], { envVars = [], deferLoad = false }: SetupOptions = {}): RobotState => {
  const files = Array.isArray(scriptFiles) ? scriptFiles : [scriptFiles]
  // assigned in beforeEach
  const state = { robot: null, loadScript: null } as unknown as RobotState
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(async () => {
    process.env.EXPRESS_PORT = '0'
    for (const name of envVars) originalEnv[name] = process.env[name]
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
  robot.on(event, (envelope: unknown, ...strings: string[]) => { messages.push(strings.join('')) })
  return messages
}

export const brainUser = (robot: Robot, id: string, name: string, extra: Record<string, unknown> = {}): User =>
  robot.brain.userForId(id, { name, ...extra })
