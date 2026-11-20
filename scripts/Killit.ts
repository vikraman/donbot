// Description:
//   Make "Kill it with fire!" jokes
//
// Commands:
//   kill - Now and then answers 'Kill it, kill it with fire!'
//

import type { Robot } from 'hubot'

import { cooldown } from './lib/cooldown.ts'
import { chance } from './lib/random.ts'
import { defineFeature } from './lib/features.ts'

defineFeature({ id: 'killit', label: 'Kill it with fire', level: 'casual', help: ['kill - '] })

// quiet period per room after a joke
export const KILLIT_COOLDOWN_MS = 10 * 60 * 1000

export default async (robot: Robot) => {
  const roomCooldown = cooldown(KILLIT_COOLDOWN_MS)

  robot.hear(/\bkill([A-Za-z0-9]*)\b/, { id: 'killit.hear' }, async res => {
    const room = res.message.room
    if (!roomCooldown.ready(room) || !chance(0.314)) return
    roomCooldown.mark(room)
    await res.send('Kill it, kill it with fire!')
  })
}
