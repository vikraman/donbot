import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Roles testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Roles.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
    mock.reset()
  })
  it('should assign a role to a user', async () => {
    const author = robot.brain.userForId('author-id', { name: 'author' })
    robot.brain.userForId('holman-id', { name: 'holman' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(author, '@Dumbotheelephant holman is an ego surfer', 'test-room')
    assert.strictEqual(sent[0], 'Ok, holman is an ego surfer.')
  })
  it('should report roles when asked who a user is', async () => {
    const author = robot.brain.userForId('author-id', { name: 'author' })
    robot.brain.userForId('holman-id', { name: 'holman' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(author, '@Dumbotheelephant holman is an ego surfer', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant who is holman', 'test-room')
    assert.strictEqual(sent[1], 'holman is an ego surfer.')
  })
  it('should remove a role from a user', async () => {
    const author = robot.brain.userForId('author-id', { name: 'author' })
    robot.brain.userForId('holman-id', { name: 'holman' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(author, '@Dumbotheelephant holman is an ego surfer', 'test-room')
    await robot.adapter.say(author, '@Dumbotheelephant holman is not an ego surfer', 'test-room')
    assert.strictEqual(sent[1], 'Ok, holman is no longer an ego surfer.')
  })
  it('should say it knows nothing about an unknown user', async () => {
    mock.method(Math, 'random', () => 0)
    const author = robot.brain.userForId('author-id', { name: 'author' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(author, '@Dumbotheelephant nobody is a mystery', 'test-room')
    assert.strictEqual(sent[0], "I don't know anything about nobody.")
  })
  it('should vary the response when a known user has no roles', async () => {
    mock.method(Math, 'random', () => 0)
    const author = robot.brain.userForId('author-id', { name: 'author' })
    robot.brain.userForId('holman-id', { name: 'holman' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(author, '@Dumbotheelephant who is holman', 'test-room')
    assert.strictEqual(sent[0], 'holman is nothing to me.')
  })
})
