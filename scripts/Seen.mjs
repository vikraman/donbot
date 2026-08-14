// Description:
//   Tracks when each user was last seen; keeps the brain's known-user list up to date
//   so other commands can find people by name.
//
// Commands:
//   hubot seen <user> - Shows when <user> was last seen.
//   hubot who do you know - Lists everyone the bot has seen talk.
//   hubot who is your owner - Shows who owns/runs the bot.
//

import { mentionFor } from './lib/mention.mjs'

const seenKey = userId => `seen:${userId}`
const LAST_MESSAGE_KEY = 'seen:last'

export default async (robot) => {
  robot.hear(/.*/, async res => {
    const user = res.message.user
    if (user && user.id != null) {
      const known = robot.brain.userForId(user.id, { name: user.name })
      known.name = user.name
      const now = Date.now()
      robot.brain.set(seenKey(user.id), { name: user.name, time: now })
      robot.brain.set(LAST_MESSAGE_KEY, now)
    }
  })

  robot.respond(/who do you know\??$/i, async res => {
    const users = Object.values(robot.brain.data.users || {})
    const names = [...new Set(users.map(u => u.name).filter(Boolean))].sort((a, b) => a.localeCompare(b))

    if (names.length === 0) {
      await res.send("I don't know anyone yet.")
      return
    }
    await res.send(`I know ${names.length} ${names.length === 1 ? 'person' : 'people'}: ${names.join(', ')}`)
  })

  robot.respond(/who(?:'s| is) your owner\??$|who (?:made|owns|runs) you\??$/i, async res => {
    const ownerId = process.env.OWNER_USER_ID
    if (!ownerId) {
      await res.send("I don't have an owner configured.")
      return
    }

    const owner = robot.brain.data.users && robot.brain.data.users[ownerId]
    await res.send(owner ? `${owner.name} owns me.` : "My owner hasn't said anything yet, so I don't know their name.")
  })

  robot.respond(/(?:seen|have you seen|when (?:was|did you see)) ([\w .-]+?)\??\s*$/i, async res => {
    const name = res.match[1].trim()
    const users = robot.brain.usersForFuzzyName(name)

    if (users.length === 0) {
      await res.send(`I don't know anything about ${name}.`)
      return
    }
    if (users.length > 1) {
      await res.send(`Be more specific, I know ${users.length} people named like that: ${users.map(u => u.name).join(', ')}`)
      return
    }

    const entry = robot.brain.get(seenKey(users[0].id))
    if (!entry) {
      await res.send(`I haven't seen ${name} say anything.`)
      return
    }
    await res.send(`${mentionFor({ id: users[0].id, name: entry.name })} was last seen ${new Date(entry.time).toISOString()}`)
  })
}
