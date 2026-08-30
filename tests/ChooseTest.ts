import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const randomOrgResponse = (data: number[]) => ({
  ok: true,
  json: async () => ({ result: { random: { data } } })
}) as unknown as Response

describe('Choose testing Hubot scripts', () => {
  const state = setupRobot('Choose.ts', { envVars: ['RANDOM_ORG_API_KEY'] })

  it('should pick one of the given options using random.org', async () => {
    const { robot } = state
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => randomOrgResponse(Array(50).fill(1)))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza or tacos', 'test-room')
    assert.strictEqual(sent[0], 'tacos')
  })
  it('should support "pick" as an alternate trigger word', async () => {
    const { robot } = state
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => randomOrgResponse(Array(50).fill(0)))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant pick pizza or tacos', 'test-room')
    assert.strictEqual(sent[0], 'pizza')
  })
  it('should complain with fewer than two options', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza', 'test-room')
    assert.match(sent[0]!, /at least two options/)
  })
  it('should fall back to secure local randomness when random.org fails', async () => {
    const { robot } = state
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => { throw new Error('network down') })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza or tacos', 'test-room')
    assert.ok(['pizza', 'tacos'].includes(sent[0]!))
  })
  it('should fall back to secure local randomness when no api key is configured', async () => {
    const { robot } = state
    delete process.env.RANDOM_ORG_API_KEY
    const fetchMock = mock.method(global, 'fetch', async () => { throw new Error('should not be called') })
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant choose pizza or tacos', 'test-room')
    assert.ok(['pizza', 'tacos'].includes(sent[0]!))
    assert.strictEqual(fetchMock.mock.calls.length, 0)
  })
  it('should roll a single number in range', async () => {
    const { robot } = state
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => randomOrgResponse(Array(50).fill(42)))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant roll a number between 1 and 100', 'test-room')
    assert.strictEqual(sent[0], '42')
  })
  it('should roll multiple numbers in range', async () => {
    const { robot } = state
    process.env.RANDOM_ORG_API_KEY = 'test-key'
    mock.method(global, 'fetch', async () => randomOrgResponse([3, 7, 9, ...Array(47).fill(1)]))
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = collect(robot)
    await robot.adapter.say(user, '@Dumbotheelephant roll 3 numbers between 1 and 10', 'test-room')
    assert.strictEqual(sent[0], '3, 7, 9')
  })
})
