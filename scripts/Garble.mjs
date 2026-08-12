// Description:
//   Garbles the interior letters of each word, keeping first and last letters in place.
//
// Commands:
//   hubot garble <text> - Garbles <text>.
//

const shuffle = letters => {
  const arr = letters.split('')
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
  return arr.join('')
}

const garbleWord = word => {
  if (word.length <= 3) return word
  const first = word[0]
  const last = word[word.length - 1]
  const middle = shuffle(word.slice(1, -1))
  return first + middle + last
}

export default async (robot) => {
  robot.respond(/garble (.+)$/i, async res => {
    const garbled = res.match[1].split(' ').map(garbleWord).join(' ')
    await res.send(garbled)
  })
}
