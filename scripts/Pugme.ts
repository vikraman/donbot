// Description:
//   Displays random dog images.
//
// Commands:
//   hubot pug me - Receive a random dog image.
//

import type { Robot } from 'hubot'
import { defineFeature } from './lib/features.ts'

defineFeature({ id: 'pugme', label: 'Dog pictures', level: 'professional', web: true, help: ['hubot pug me'] })

interface DogApiResponse {
  message: string
}

export default async (robot: Robot) => {
  robot.respond(/(?:pug me|show me a pug|pug(?:gy)? pic(?:ture)?)$/i, { id: 'pugme.show' }, async res => {
    const response = await fetch('https://dog.ceo/api/breeds/image/random')
    const data = await response.json() as DogApiResponse
    await res.send(data.message)
  })
}
