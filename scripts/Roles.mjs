// Description:
//   Assign roles to people you're chatting with
//
// Commands:
//   hubot <user> is a badass guitarist - assign a role to a user
//   hubot <user> is not a badass guitarist - remove a role from a user
//   hubot who is <user> - see what roles a user has
//
// Examples:
//   hubot holman is an ego surfer
//   hubot holman is not an ego surfer

const getAmbiguousUserText = users =>
  `Be more specific, I know ${users.length} people named like that: ${users.map(u => u.name).join(', ')}`

import { pick } from './lib/random.mjs'

const skipNames = ['', 'who', 'what', 'where', 'when', 'why']

const NOTHING_TO_ME = [
  '{name} is nothing to me.',
  "I've got nothing on {name}.",
  "{name}? Blank slate.",
  "No roles for {name} yet."
]

const NEVER_HEARD = [
  "{name}? Never heard of 'em",
  "{name} who?",
  "Doesn't ring a bell: {name}",
  "I don't know any {name}."
]

const UNKNOWN_USER = [
  "I don't know anything about {name}.",
  "Never met {name}.",
  "{name} is a mystery to me.",
  "No idea who {name} is."
]

const fillTemplate = (template, name) => template.replace('{name}', name)

export default async (robot) => {
  robot.respond(/who is @?([\w .-]+)\?*$/i, async res => {
    const joiner = ', '
    const name = res.match[1].trim()

    if (name === 'you') {
      await res.send("Who ain't I?")
    } else if (name === robot.name) {
      await res.send('The best.')
    } else {
      const users = robot.brain.usersForFuzzyName(name)
      if (users.length === 1) {
        const user = users[0]
        user.roles = user.roles || []
        if (user.roles.length > 0) {
          const j = user.roles.join('').includes(',') ? '; ' : joiner
          await res.send(`${name} is ${user.roles.join(j)}.`)
        } else {
          await res.send(fillTemplate(pick(NOTHING_TO_ME), name))
        }
      } else if (users.length > 1) {
        await res.send(getAmbiguousUserText(users))
      } else {
        await res.send(fillTemplate(pick(NEVER_HEARD), name))
      }
    }
  })

  robot.respond(/@?([\w .\-_]+) is (["'\w: -_]+)[.!]*$/i, async res => {
    const name = res.match[1].trim()
    const newRole = res.match[2].trim()

    if (skipNames.includes(name.toLowerCase()) || newRole.match(/^not\s+/i)) {
      return
    }

    const users = robot.brain.usersForFuzzyName(name)
    if (users.length === 1) {
      const user = users[0]
      user.roles = user.roles || []

      if (user.roles.includes(newRole)) {
        await res.send('I know')
      } else {
        user.roles.push(newRole)
        if (name.toLowerCase() === robot.name.toLowerCase()) {
          await res.send(`Ok, I am ${newRole}.`)
        } else {
          await res.send(`Ok, ${name} is ${newRole}.`)
        }
      }
    } else if (users.length > 1) {
      await res.send(getAmbiguousUserText(users))
    } else {
      await res.send(fillTemplate(pick(UNKNOWN_USER), name))
    }
  })

  robot.respond(/@?([\w .\-_]+) is not (["'\w: -_]+)[.!]*$/i, async res => {
    const name = res.match[1].trim()
    const newRole = res.match[2].trim()

    if (skipNames.includes(name.toLowerCase())) {
      return
    }

    const users = robot.brain.usersForFuzzyName(name)
    if (users.length === 1) {
      const user = users[0]
      user.roles = user.roles || []

      if (!user.roles.includes(newRole)) {
        await res.send('I know.')
      } else {
        user.roles = user.roles.filter(role => role !== newRole)
        await res.send(`Ok, ${name} is no longer ${newRole}.`)
      }
    } else if (users.length > 1) {
      await res.send(getAmbiguousUserText(users))
    } else {
      await res.send(fillTemplate(pick(UNKNOWN_USER), name))
    }
  })
}
