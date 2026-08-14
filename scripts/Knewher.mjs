// Description:
//   Make "I barely knew her!" jokes
//
// Commands:
//   functor - hubot says 'Functor? I barely knew her!'
//

import { pick, chance } from './lib/random.mjs'

export default async (robot) => {
  robot.hear(/\b((?:[A-Za-z0-9]+){4,9}(?:or|er))(?:s?)(?:[^\w\s])?\b/, async res => {
    const name = res.match[1]
    const word = name[0].toUpperCase() + name.slice(1)
    const jokes = [
      'I barely knew her!',
      'But I barely know her!',
      'I just met her!',
      'But I only just met her!'
    ]
    const joke = pick(jokes)
    if (chance(0.314)) {
      await res.send(`${word}? ${joke}`)
    }
  })
}
