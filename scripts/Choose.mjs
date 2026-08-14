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

import { randomInt, randomInts } from './lib/random.mjs'

export default async (robot) => {
  robot.respond(/(?:choose|pick)\s+(.+)$/i, async res => {
    const options = res.match[1].split(/\s+or\s+/i).map(o => o.trim()).filter(Boolean)
    if (options.length < 2) {
      await res.send('Give me at least two options, separated by "or".')
      return
    }
    const index = await randomInt(robot, 0, options.length - 1)
    await res.send(options[index])
  })

  robot.respond(/roll (?:a |an )?number (?:between|from) (-?\d+) (?:and|to) (-?\d+)$/i, async res => {
    const min = Math.min(Number(res.match[1]), Number(res.match[2]))
    const max = Math.max(Number(res.match[1]), Number(res.match[2]))
    const number = await randomInt(robot, min, max)
    await res.send(`${number}`)
  })

  robot.respond(/roll (\d+) numbers (?:between|from) (-?\d+) (?:and|to) (-?\d+)$/i, async res => {
    const count = Math.min(Number(res.match[1]), 100)
    const min = Math.min(Number(res.match[2]), Number(res.match[3]))
    const max = Math.max(Number(res.match[2]), Number(res.match[3]))
    const numbers = await randomInts(robot, count, min, max)
    await res.send(numbers.join(', '))
  })
}
