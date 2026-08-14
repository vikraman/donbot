import { beforeEach, afterEach, mock } from 'node:test'

import { Robot } from 'hubot'

import dummyRobot from '../doubles/DummyAdapter.mjs'

// shared robot bootstrap. envVars are snapshotted/restored per test.
// deferLoad: skip auto-load; caller runs state.loadScript() after setting up robot.adapter.client
// (needed by Presence/StarReact/Praise, which read the client at load/connect time)
export const setupRobot = (scriptFiles, { envVars = [], deferLoad = false } = {}) => {
  const files = Array.isArray(scriptFiles) ? scriptFiles : [scriptFiles]
  const state = { robot: null, loadScript: null }
  const originalEnv = {}

  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    for (const name of envVars) originalEnv[name] = process.env[name]
    state.robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
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
    mock.reset()
  })

  return state
}

// collects joined strings from each robot.on(event) emission
export const collect = (robot, event = 'send') => {
  const messages = []
  robot.on(event, (envelope, ...strings) => { messages.push(strings.join('')) })
  return messages
}

export const brainUser = (robot, id, name, extra = {}) =>
  robot.brain.userForId(id, { name, ...extra })
