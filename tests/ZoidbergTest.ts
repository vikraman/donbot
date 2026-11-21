import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'

import { setupRobot, brainUser } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'

// raw args, collect would stringify the attachment
const capture = (robot: TestRobot): unknown[][] => {
  const sent: unknown[][] = []
  robot.on('send', (_envelope: unknown, ...strings: unknown[]) => { sent.push(strings) })
  return sent
}

describe('Zoidberg testing Hubot scripts', () => {
  const state = setupRobot('Zoidberg.ts')

  for (const text of ['whoop', 'whoop whoop whoop', 'Zoidberg']) {
    it(`whoops for "${text}"`, async () => {
      const { robot } = state
      const user = brainUser(robot, 'test-user', 'test user')
      const sent = capture(robot)
      await robot.adapter.say(user, `@Dumbotheelephant ${text}`, 'test-room')
      assert.deepStrictEqual(sent[0], ['(V) (°,,,,°) (V) whoop whoop whoop'])
      const files = (sent[1]![0] as { files: { file: string, name: string }[] }).files
      assert.strictEqual(files.length, 1)
      assert.strictEqual(files[0]!.name, 'zoidberg-whoop.mp3')
      assert.ok(existsSync(files[0]!.file))
    })
  }

  it('ignores other whooping', async () => {
    const { robot } = state
    const user = brainUser(robot, 'test-user', 'test user')
    const sent = capture(robot)
    await robot.adapter.say(user, '@Dumbotheelephant whoopsie', 'test-room')
    await robot.adapter.say(user, 'whoop', 'test-room')
    assert.deepStrictEqual(sent, [])
  })
})
