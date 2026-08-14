// Description:
//   Garbles the interior letters of each word, keeping first and last letters in place.
//
// Commands:
//   hubot garble <text> - Garbles <text>.
//

import { shuffle } from './lib/random.mjs'

const garbleWord = word => {
  if (word.length <= 3) return word
  const first = word[0]
  const last = word[word.length - 1]
  const middle = shuffle(word.slice(1, -1).split('')).join('')
  return first + middle + last
}

export default async (robot) => {
  robot.respond(/(?:garble|scramble)\s+(.+)$/i, async res => {
    const garbled = res.match[1].split(' ').map(garbleWord).join(' ')
    await res.send(garbled)
  })
}
