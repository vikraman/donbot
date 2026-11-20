// Description:
//   Persists a counter in the robot brain to verify redis-brain works.
//
// Commands:
//   hubot count - Increments and returns the counter.
//

import type { Robot } from 'hubot'

import { defineFeature } from './lib/features.ts'
import { storeOf } from './lib/spaces.ts'

defineFeature({ id: 'count', label: 'Counter', level: 'casual', help: ['hubot count'] })

export default async (robot: Robot) => {
  robot.respond(/count(?: it| it up|er)?$/i, { id: 'count.inc' }, async res => {
    const store = storeOf(robot, res)
    const stored = store.get('count')
    const count = (typeof stored === 'number' ? stored : 0) + 1
    store.set('count', count)
    await res.reply(`Count is now ${count}`)
  })
}
