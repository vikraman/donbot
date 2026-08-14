// Description:
//   Make "Kill it with fire!" jokes
//
// Commands:
//   kill - hubot says 'Kill it, Kill it with fire!'
//

import { chance } from './lib/random.mjs'

export default async (robot) => {
  robot.hear(/\bkill([A-Za-z0-9]*)\b/, async res => {
    if (chance(0.314)) {
      await res.send('Kill it, kill it with fire!')
    }
  })
}
