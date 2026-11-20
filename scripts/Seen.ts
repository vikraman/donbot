// Description:
//   Tracks when each user was last seen; keeps the brain's known-user list up to date
//   so other commands can find people by name.
//
// Commands:
//   hubot seen <user> - Shows when <user> was last seen in this server.
//   hubot who do you know - Lists everyone the bot has seen talk in this server.
//   hubot who is your owner - Shows who owns/runs the bot.
//

import type { Robot } from 'hubot'

import { required } from './lib/match.ts'

import { defineFeature } from './lib/features.ts'
import { allows } from './lib/policy.ts'
import { findPeople, learnMember, membersOf, spaceOfRes, type SpaceId } from './lib/spaces.ts'

defineFeature({ id: 'directory', label: 'Known names', level: 'professional', infra: true })
defineFeature({ id: 'seen', label: 'Last seen', level: 'professional', passive: true, stores: 'when each person last spoke', help: ['hubot seen', 'hubot who do you know'] })
defineFeature({ id: 'about', label: 'About donbot', level: 'professional', help: ['hubot who is your owner'] })

const LAST_MESSAGE_KEY = 'seen:last'

const isDmSpace = (space: SpaceId): boolean => space.startsWith('dm:')

export default async (robot: Robot) => {
  robot.hear(/.*/, { id: 'directory.learn' }, async res => {
    const user = res.message.user
    if (user && user.id != null) {
      // names always, times only where seen is on
      const known = robot.brain.userForId(user.id, { name: user.name })
      known.name = user.name
      const now = Date.now()
      const space = spaceOfRes(robot, res)
      if (!isDmSpace(space)) learnMember(robot, space, String(user.id), user.name, allows(robot, res, 'seen') ? now : undefined)
      robot.brain.set(LAST_MESSAGE_KEY, now)
    }
  })

  robot.respond(/who do you know\??$/i, { id: 'seen.who' }, async res => {
    const space = spaceOfRes(robot, res)
    if (isDmSpace(space)) {
      await res.send('I only keep track of people in servers.')
      return
    }
    const names = Object.values(membersOf(robot, space)).filter(m => m.seen !== undefined).map(m => m.name)
    const sorted = [...new Set(names)].sort((a, b) => a.localeCompare(b))
    if (sorted.length === 0) {
      await res.send("I don't know anyone here yet.")
      return
    }
    await res.send(`I know ${sorted.length} ${sorted.length === 1 ? 'person' : 'people'}: ${sorted.join(', ')}`)
  })

  robot.respond(/who(?:'s| is) your owner\??$|who (?:made|owns|runs) you\??$/i, { id: 'about.owner' }, async res => {
    const ownerId = process.env.OWNER_USER_ID
    if (!ownerId) {
      await res.send("I don't have an owner configured.")
      return
    }

    const owner = robot.brain.data.users && robot.brain.data.users[ownerId]
    await res.send(owner ? `${owner.name} owns me.` : "My owner hasn't said anything yet, so I don't know their name.")
  })

  robot.respond(/(?:seen|have you seen|when (?:was|did you see)) ([\w .-]+?)\??\s*$/i, { id: 'seen.query' }, async res => {
    const name = required(res.match, 1).trim()
    const space = spaceOfRes(robot, res)
    if (isDmSpace(space)) {
      await res.send('I only keep track of people in servers.')
      return
    }
    // seen here only
    const members = membersOf(robot, space)
    const seen = findPeople(robot, space, name).filter(p => members[p.id]?.seen !== undefined)

    if (seen.length === 0) {
      await res.send(`I haven't seen ${name} here.`)
      return
    }
    if (seen.length > 1) {
      await res.send(`Be more specific, I know ${seen.length} people named like that: ${seen.map(p => p.name).join(', ')}`)
      return
    }

    // name, not a mention
    const [person] = seen
    await res.send(`${person!.name} was last seen ${new Date(members[person!.id]!.seen!).toISOString()}`)
  })
}
