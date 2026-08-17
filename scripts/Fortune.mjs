// Description:
//   Fetches a fortune cookie from desync's cookie jar.
//
// Commands:
//   hubot fortune - Shows a fortune cookie.
//

import { pick } from './lib/random.mjs';

export default async (robot) => {
  robot.respond(/(?:fortune)?$/i, async res => {
    const word = res.match[1].trim()
    const response = await fetch(`https://cokernelpanic.com/assets/text/fortunes.md`)

    if (!response.ok) {
      await res.send(`Fortune unavailable.`)
      return
    }

    const fortunes = await response.text().split('\n').filter(line => line.trim() !== '')
    const fortune = pick(fortunes)

    if (!fortune) {
      await res.send(`No fortune found.`)
      return
    }

    await res.send(fortune)
  })
}
