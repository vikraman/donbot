// Description:
//   Displays random dog images.
//
// Commands:
//   hubot pug me - Receive a random dog image.
//

import type { Robot } from 'hubot'

interface DogApiResponse {
  message: string
}

export default async (robot: Robot) => {
  robot.respond(/(?:pug me|show me a pug|pug(?:gy)? pic(?:ture)?)$/i, async res => {
    const response = await fetch('https://dog.ceo/api/breeds/image/random')
    const data: DogApiResponse = await response.json()
    await res.send(data.message)
  })
}
