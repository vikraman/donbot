// Description:
//   Persists a counter in the robot brain to verify redis-brain works.
//
// Commands:
//   hubot count - Increments and returns the counter.
//

import type { Robot } from 'hubot'

import { scoreAt } from './lib/brainScan.ts'

export default async (robot: Robot) => {
  robot.respond(/count(?: it| it up|er)?$/i, async res => {
    const count = scoreAt(robot, 'count') + 1
    robot.brain.set('count', count)
    await res.reply(`Count is now ${count}`)
  })
}
