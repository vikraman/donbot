// Description:
//   Fetches a fortune cookie from desync's cookie jar.
//
// Commands:
//   hubot fortune - Shows a fortune cookie.
//

import type { Robot } from 'hubot'

import { pick } from './lib/random.ts'

export default async (robot: Robot) => {
  robot.respond(/fortune$/i, async res => {
    const response = await fetch(`https://cokernelpanic.com/assets/text/fortunes.md`)

    if (!response.ok) {
      await res.send(`Fortune unavailable.`)
      return
    }

    const data = await response.text();
    const fortunes = data.split('\n').filter(line => line.trim() !== '');
    const fortune = pick(fortunes)

    if (!fortune) {
      await res.send(`No fortune found.`)
      return
    }

    await res.send(fortune)
  })
}
