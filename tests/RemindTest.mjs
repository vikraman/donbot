import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'

import { Robot } from 'hubot'

import dummyRobot from './doubles/DummyAdapter.mjs'

describe('Remind testing Hubot scripts', () => {
  let robot = null
  beforeEach(async () => {
    process.env.EXPRESS_PORT = 0
    robot = new Robot(dummyRobot, true, 'Dumbotheelephant')
    await robot.loadAdapter()
    await robot.run()
    await robot.loadFile('./scripts', 'Remind.mjs')
  })
  afterEach(() => {
    delete process.env.EXPRESS_PORT
    robot.shutdown()
  })
  it('should acknowledge setting a reminder', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should support the "set a reminder for" alternate phrasing', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant set a reminder for 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should reject an unknown unit', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 fortnights to stretch', 'test-room')
    assert.match(sent[0], /don't understand the unit/)
  })
  it('should fire the reminder after the delay elapses', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 1 seconds to stretch', 'test-room')
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.strictEqual(sent[1], '<@test-user> reminder: stretch')
  })
  it('should support "to <message> in <N> <unit>" phrasing', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me to stretch in 5 minutes', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind you in 5 minutes.")
  })
  it('should set a reminder for another user by name', async () => {
    robot.brain.userForId('bob-id', { name: 'bob' })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind <@bob-id> in 5 minutes.")
  })
  it('should set a reminder for another user via a Discord mention', async () => {
    robot.brain.userForId('12345', { name: 'bob' })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind <@12345> in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind <@12345> in 5 minutes.")
  })
  it('should notify the target user, not the sender, when the reminder fires', async () => {
    robot.brain.userForId('bob-id', { name: 'bob' })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind bob to stretch in 1 seconds', 'test-room')
    await new Promise(resolve => setTimeout(resolve, 1200))
    assert.strictEqual(sent[1], '<@bob-id> reminder: stretch')
  })
  it('should fall back to a plain name when the target has no known Discord id', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind nobody-known in 5 minutes to stretch', 'test-room')
    assert.strictEqual(sent[0], "Ok, I'll remind @nobody-known in 5 minutes.")
  })
  it('should say there are no pending reminders when the room has none', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant list reminders', 'test-room')
    assert.strictEqual(sent[0], 'No pending reminders in this room.')
  })
  it('should list pending reminders in the current room', async () => {
    robot.brain.userForId('bob-id', { name: 'bob' })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 1 hour to review PR', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind list', 'test-room')
    assert.match(sent[2], /for <@test-user>: stretch/)
    assert.match(sent[2], /for <@bob-id>: review PR/)
  })
  it('should only list the requester\'s own reminders with "my reminders"', async () => {
    robot.brain.userForId('bob-id', { name: 'bob' })
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant remind bob in 1 hour to review PR', 'test-room')
    await robot.adapter.say(user, '@Dumbotheelephant my reminders', 'test-room')
    assert.match(sent[2], /for <@test-user>: stretch/)
    assert.doesNotMatch(sent[2], /bob/)
  })
  it('should not list reminders from other rooms', async () => {
    const user = robot.brain.userForId('test-user', { name: 'test user' })
    const sent = []
    robot.on('send', (envelope, ...strings) => { sent.push(strings.join('')) })
    await robot.adapter.say(user, '@Dumbotheelephant remind me in 5 minutes to stretch', 'other-room')
    await robot.adapter.say(user, '@Dumbotheelephant list reminders', 'test-room')
    assert.strictEqual(sent[1], 'No pending reminders in this room.')
  })
})
