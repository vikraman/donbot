// Description:
//   Remembers each person's timezone, used by reminders and other scheduled things.
//
// Commands:
//   hubot my timezone is <zone> - Sets your timezone, e.g. Europe/London or America/New_York.
//   hubot my timezone - Shows your timezone.
//   hubot time for <user> - Shows the local time for <user>.
//
// Configuration:
//   DEFAULT_TIMEZONE - Timezone for people who haven't set one. Defaults to Europe/London.
//

import type { Robot } from 'hubot'

import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { canonicalTz, formatClock, zonedParts } from './lib/time.ts'
import { setUserTz, tzNote, userTz } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { peopleFor } from './lib/spaces.ts'

defineFeature({ id: 'timezone', label: 'Timezones', level: 'professional', help: ['hubot my timezone', 'hubot time for'] })

const localTime = (tz: string, now = Date.now()): string => {
  const p = zonedParts(now, tz)
  const date = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(now))
  return `${formatClock(p.hour, p.minute)} on ${date}`
}

export default async (robot: Robot) => {
  robot.respond(/my (?:timezone|time zone|tz) is (\S+)$/i, { id: 'timezone.set' }, async res => {
    const input = required(res.match, 1)
    const tz = canonicalTz(input)
    if (!tz) {
      await res.send(`I don't know the timezone "${input}". Use a name like Europe/London, America/New_York or Asia/Kolkata.`)
      return
    }
    setUserTz(robot, res.message.user.id, tz)
    await res.send(`Got it, your timezone is ${tz}. It's ${localTime(tz)} for you.`)
  })

  robot.respond(/(?:what(?:'s| is) )?my (?:timezone|time zone|tz)\??$/i, { id: 'timezone.show' }, async res => {
    const tz = userTz(robot, res.message.user.id)
    await res.send(`Your timezone is ${tz}. It's ${localTime(tz)} for you.`)
  })

  robot.respond(/(?:what time is it for|(?:local )?time for) @?(.+?)\??$/i, { id: 'timezone.for' }, async res => {
    const who = required(res.match, 1).trim()
    let user: { id: string, name?: string } | undefined
    const mention = who.match(/^<@!?(\d+)>$/)
    if (who.toLowerCase() === 'me') user = res.message.user
    else if (mention) user = { id: required(mention, 1), name: robot.brain.data.users[required(mention, 1)]?.name }
    else {
      const users = peopleFor(robot, res, who)
      if (users.length > 1) {
        await res.send(`Be more specific, I know ${users.length} people named like that: ${users.map(u => u.name).join(', ')}`)
        return
      }
      user = users[0]
    }
    if (!user) {
      await res.send(`I don't know anyone called ${who}.`)
      return
    }
    const tz = userTz(robot, user.id)
    await res.send(`It's ${localTime(tz)} for ${mentionFor(user)}${tzNote(tz)}.`)
  })
}
