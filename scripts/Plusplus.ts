// Description:
//   Give or take away points to/from things.
//
// Commands:
//   <thing>++ - Increments points for <thing>.
//   <thing>-- - Decrements points for <thing>.
//   hubot score for <thing> - Shows points for <thing>.
//

import type { Robot } from 'hubot'

import { scoreAt } from './lib/brainScan.ts'
import { required } from './lib/match.ts'

const scoreKey = (thing: string): string => `plusplus:${thing.toLowerCase()}`

export default async (robot: Robot) => {
  robot.hear(/^\s*([\w .-]+?)\s*(\+\+|--)\s*$/, async res => {
    const thing = required(res.match, 1).trim()
    const delta = required(res.match, 2) === '++' ? 1 : -1
    const key = scoreKey(thing)
    const score = scoreAt(robot, key) + delta
    robot.brain.set(key, score)
    await res.send(`${thing}: ${score}`)
  })

  robot.respond(/(?:score for|points for|how many points does) ([\w .-]+?) ?(?:have)?\s*$/i, async res => {
    const thing = required(res.match, 1).trim()
    const score = scoreAt(robot, scoreKey(thing))
    await res.send(`${thing}: ${score}`)
  })
}
