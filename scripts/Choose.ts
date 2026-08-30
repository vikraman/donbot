// Description:
//   Random decisions and numbers via random.org, falls back to secure local randomness.
//
// Commands:
//   hubot choose <a> or <b> or <c> - Picks one option at random.
//   hubot roll a number between <min> and <max> - Picks a random integer in range.
//   hubot roll <N> numbers between <min> and <max> - Picks N random integers in range.
//
// Configuration:
//   RANDOM_ORG_API_KEY - API key for random.org true RNG (https://api.random.org/dashboard). Optional; falls back to secure local randomness without it.
//

import type { Robot } from 'hubot'

import { required } from './lib/match.ts'

import { randomInt, randomInts } from './lib/random.ts'

export default async (robot: Robot) => {
  robot.respond(/(?:choose|pick)\s+(.+)$/i, async res => {
    const options = required(res.match, 1).split(/\s+or\s+/i).map(o => o.trim()).filter(Boolean)
    if (options.length < 2) {
      await res.send('Give me at least two options, separated by "or".')
      return
    }
    const index = await randomInt(robot, 0, options.length - 1)
    await res.send(options[index] ?? options[0]!)
  })

  robot.respond(/roll (?:a |an )?number (?:between|from) (-?\d+) (?:and|to) (-?\d+)$/i, async res => {
    const min = Math.min(Number(required(res.match, 1)), Number(required(res.match, 2)))
    const max = Math.max(Number(required(res.match, 1)), Number(required(res.match, 2)))
    const number = await randomInt(robot, min, max)
    await res.send(`${number}`)
  })

  robot.respond(/roll (\d+) numbers (?:between|from) (-?\d+) (?:and|to) (-?\d+)$/i, async res => {
    const count = Math.min(Number(required(res.match, 1)), 100)
    const min = Math.min(Number(required(res.match, 2)), Number(required(res.match, 3)))
    const max = Math.max(Number(required(res.match, 2)), Number(required(res.match, 3)))
    const numbers = await randomInts(robot, count, min, max)
    await res.send(numbers.join(', '))
  })
}
