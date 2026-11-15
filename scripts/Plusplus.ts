// Description:
//   Give or take away points to/from things.
//
// Commands:
//   <thing>++ - Increments points for <thing>.
//   <thing>-- - Decrements points for <thing>.
//   hubot score for <thing> - Shows points for <thing>.
//
// Each user can change a thing's score once every 5 minutes, and at most 5 scores a minute;
// votes past either limit are ignored.
//

import type { Robot } from 'hubot'

import { scoreAt } from './lib/brainScan.ts'
import { burst, cooldown } from './lib/cooldown.ts'
import { required } from './lib/match.ts'

const scoreKey = (thing: string): string => `plusplus:${thing.toLowerCase()}`

// per user per thing
export const VOTE_COOLDOWN_MS = 5 * 60 * 1000
// per user, across things
export const MAX_VOTES_PER_WINDOW = 5
export const VOTE_WINDOW_MS = 60 * 1000

export default async (robot: Robot) => {
  const voteCooldown = cooldown(VOTE_COOLDOWN_MS)
  const voteBurst = burst(MAX_VOTES_PER_WINDOW, VOTE_WINDOW_MS)

  robot.hear(/^\s*([\w .-]+?)\s*(\+\+|--)\s*$/, async res => {
    const thing = required(res.match, 1).trim()
    const delta = required(res.match, 2) === '++' ? 1 : -1
    const key = scoreKey(thing)
    const voter = res.message.user.id
    const voteKey = `${voter}:${key}`
    if (!voteCooldown.ready(voteKey) || !voteBurst.take(voter)) return
    voteCooldown.mark(voteKey)
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
