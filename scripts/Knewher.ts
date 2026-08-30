// Description:
//   Make "I barely knew her!" jokes
//
// Commands:
//   functor - hubot says 'Functor? I barely knew her!'
//

import type { Robot } from 'hubot'

import { required } from './lib/match.ts'
import { pick, chance } from './lib/random.ts'
import { isRareWord } from './lib/wordRarity.ts'

export default async (robot: Robot) => {
  robot.hear(/\b([A-Za-z]{4,9}(?:or|er))s?\b/, async res => {
    const name = required(res.match, 1)
    if (!isRareWord(name)) return

    const word = name.slice(0, 1).toUpperCase() + name.slice(1).toLowerCase()
    const jokes = [
      'I barely knew her!',
      'But I barely know her!',
      'I just met her!',
      'But I only just met her!',
      'But I barely even know her!'
    ] as const
    const joke = pick(jokes)
    if (chance(0.314)) {
      await res.send(`${word}? ${joke}`)
    }
  })
}
