// Description:
//   Shows an xkcd comic.
//
// Commands:
//   hubot xkcd - Shows the latest xkcd comic.
//   hubot xkcd <number> - Shows xkcd comic <number>.
//   hubot xkcd random - Shows a random xkcd comic.
//

import type { Robot } from 'hubot'

import { secureRandomInt } from './lib/random.ts'

interface XkcdComic {
  title: string
  img: string
  num: number
}

export default async (robot: Robot) => {
  robot.respond(/xkcd(?: comic)?\s*(random|\d+)?$/i, async res => {
    let number: string | undefined = res.match[1]

    if (number && number.toLowerCase() === 'random') {
      const latestResponse = await fetch('https://xkcd.com/info.0.json')
      if (!latestResponse.ok) {
        await res.send("Couldn't find that comic.")
        return
      }
      const latest: XkcdComic = await latestResponse.json()
      number = String(secureRandomInt(1, latest.num))
    }

    const url = number ? `https://xkcd.com/${number}/info.0.json` : 'https://xkcd.com/info.0.json'
    const response = await fetch(url)

    if (!response.ok) {
      await res.send("Couldn't find that comic.")
      return
    }

    const data: XkcdComic = await response.json()
    await res.send(`${data.title}: ${data.img}`)
  })
}
