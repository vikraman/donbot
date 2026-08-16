// Description:
//   Make "I barely knew her!" jokes
//
// Commands:
//   functor - hubot says 'Functor? I barely knew her!'
//

import { pick, chance } from './lib/random.mjs'
import { isRareWord } from './lib/wordRarity.mjs'

export default async (robot) => {
  robot.hear(/\b([A-Za-z]{4,9}(?:or|er))s?\b/, async res => {
    const name = res.match[1]
    if (!isRareWord(name)) return

    const word = name[0].toUpperCase() + name.slice(1).toLowerCase()
    const jokes = [
      'I barely knew her!',
      'But I barely know her!',
      'I just met her!',
      'But I only just met her!',
      'But I barely even know her!'
    ]
    const joke = pick(jokes)
    if (chance(0.314)) {
      await res.send(`${word}? ${joke}`)
    }
  })
}
