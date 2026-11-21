import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'

import { configureLines } from '../scripts/lib/lines.ts'
import { setupRobot, chat, brainUser } from './helpers/setup.ts'

const DAY = 86_400_000

describe('Wins', () => {
  const state = setupRobot('Wins.ts')
  const alice = () => chat(state, { id: 'u1', name: 'alice', room: 'room' })

  it('logs a win and cheers', async () => {
    const { robot, sent, ask } = alice()
    await ask('win shipped the parser')
    assert.strictEqual(sent.length, 1)
    assert.match(sent[0]!, /<@u1>/)
    const log = robot.brain.get<{ text: string, userId: string, room: string }[]>('log:win')!
    assert.deepStrictEqual(log.map(w => [w.userId, w.room, w.text]), [['u1', 'room', 'shipped the parser']])
  })
  it('accepts "win:" and announces streak milestones', async () => {
    const { sent, ask } = alice()
    const start = Date.now()
    for (let day = 0; day < 3; day++) {
      mock.method(Date, 'now', () => start + day * DAY)
      await ask(`win: thing ${day}`)
      mock.restoreAll()
    }
    assert.match(sent[2]!, /\n🔥 <@u1> is on a 3-day wins streak!$/)
  })
  it('lists this week\'s wins in the room, newest first', async () => {
    const { robot, sent, ask } = alice()
    const bob = brainUser(robot, 'u2', 'bob')
    await ask('wins')
    assert.match(sent[0]!, /^No wins logged here/)
    await ask('win fixed ci')
    await ask('win wrote docs', { user: bob })
    await ask('win elsewhere', { user: bob, room: 'other' })
    await ask('wins week')
    assert.strictEqual(sent[4], '• <@u2>: wrote docs (just now)\n• <@u1>: fixed ci (just now)')
  })
  it('lists wins for a person', async () => {
    const { sent, ask } = alice()
    await ask('win one')
    await ask('win two', { room: 'other' })
    await ask('wins for alice')
    assert.strictEqual(sent[2], '• <@u1>: two (just now)\n• <@u1>: one (just now)')
    await ask('wins for nobody')
    assert.strictEqual(sent[3], "I don't know nobody.")
  })
  it('notices busy days, plainly in professional rooms', async () => {
    const { sent, ask } = alice()
    for (let i = 0; i < 3; i++) await ask(`win thing ${i}`)
    assert.match(sent[2]!, /\n.*\b3\b.*today/)
    configureLines({ casual: () => false })
    await ask('win thing 3')
    assert.match(sent[3]!, /\n(That's 4 wins today\.|4 wins today\. Great progress\.)$/)
  })
  it('celebrates milestone wins', async () => {
    const { robot, sent, ask } = alice()
    robot.brain.set('wins:count:u1', 9)
    await ask('win the tenth')
    assert.match(sent[0]!, /\n🎊 .*\b10\b/)
    assert.match(sent[0]!.split('\n')[1]!, /<@u1>/)
  })
})
