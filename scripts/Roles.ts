// Description:
//   Assign roles to people you're chatting with
//
// Commands:
//   hubot <user> is a badass guitarist - assign a role to a user (Manage Roles in professional servers)
//   hubot <user> is not a badass guitarist - remove a role from a user (Manage Roles in professional servers)
//   hubot who is <user> - see what roles a user has
//
// Examples:
//   hubot holman is an ego surfer
//   hubot holman is not an ego surfer

import type { Response, Robot } from 'hubot'

import { required } from './lib/match.ts'
import { defineLines } from './lib/lines.ts'
import { userTz } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { findPeople, storeOf, type Person, type SpaceStore } from './lib/spaces.ts'
import { canManage, MANAGE_ONLY } from './lib/permissions.ts'
import { policyFor, type RawLike } from './lib/policy.ts'

defineFeature({ id: 'roles', label: 'Roles', level: 'professional', help: ['hubot <user> is', 'hubot who is <user>'] })

// user id -> roles
const ROLES_KEY = 'roles'

const rolesIn = (store: SpaceStore): Record<string, string[]> => {
  const stored = store.get(ROLES_KEY)
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, string[]> : {}
}

const setRoles = (store: SpaceStore, id: string, roles: string[]) => {
  const { [id]: _, ...rest } = rolesIn(store)
  store.set(ROLES_KEY, roles.length > 0 ? { ...rest, [id]: roles } : rest)
}

const getAmbiguousUserText = (users: Person[]): string =>
  `Be more specific, I know ${users.length} people named like that: ${users.map(u => u.name).join(', ')}`

const skipNames = ['', 'who', 'what', 'where', 'when', 'why']
// owned by other scripts
const RESERVED = /^(?:focusing|your owner|my (?:timezone|time zone|tz|github)|what time|what's my (?:timezone|time zone|tz|github))$/i
// other scripts' commands, so "win the deploy is done" isn't read as a role
const COMMAND_WORDS = new Set(['remind', 'win', 'wins', 'focus', 'tock', 'pomodoro', 'distraction', 'kudos', 'pep', 'standup', 'recap', 'poll', 'ask', 'tell', 'streaks', 'github', 'my', 'skip', 'cancel', 'forget', 'define', 'choose', 'weather', 'quote', 'joke', 'score', 'reasons', 'top', 'last', 'most', 'least', 'whimsy', 'ai', 'faq', 'deadline', 'preset'])
// people's names are short; anything longer is a sentence
const MAX_NAME_WORDS = 3

const notAName = (name: string): boolean => {
  const words = name.trim().split(/\s+/)
  return words.length > MAX_NAME_WORDS || COMMAND_WORDS.has(words[0]!.toLowerCase()) || RESERVED.test(name)
}

const nothingToMe = defineLines('roles.nothing', {
  fallback: [
    '{name} is nothing to me.',
    "I've got nothing on {name}.",
    '{name}? Blank slate.',
    'No roles for {name} yet.',
    "{name}'s file is empty. Suspiciously empty.",
    '{name} keeps a low profile. I respect that.',
    'Far as I know, {name} just shows up and nods.',
    "{name}? Haven't been told a thing. Tell me something.",
    "I know {name}, but I don't *know* {name}, you know?",
    'Nothing on record for {name}. Clean as a whistle.',
    '{name} is a person of many roles. Zero, specifically.',
    '{name}: no titles, no nicknames, no rap sheet.'
  ],
  professional: ['No roles for {name} yet.', "I don't have any roles for {name}."],
  rare: [
    '{name} is a riddle wrapped in a mystery inside a Discord account.',
    "🕵️ I've run {name} through every database I have. Both of them. Nothing.",
    '{name} has no roles, which is exactly what someone with a secret role would want.'
  ]
})

const neverHeard = defineLines('roles.never-heard', {
  fallback: [
    "{name}? Never heard of 'em",
    '{name} who?',
    "Doesn't ring a bell: {name}",
    "I don't know any {name}.",
    '{name}? Not from this neighbourhood.',
    'Never crossed paths with {name}.',
    '{name}... nope, drawing a blank.',
    'If {name} was here, nobody told me.',
    '{name}? Sounds made up.',
    "Who's {name}, and why are they asking for me?",
    'No {name} in my little black book.',
    "Can't place {name}. Have 'em say hi sometime."
  ],
  professional: ["I don't know anyone called {name}.", "I don't recognise {name}."],
  rare: [
    "{name}? I've never met them, but I've heard the songs.",
    '📇 I checked the rolodex. Twice. {name} remains a rumour.'
  ]
})

const unknownUser = defineLines('roles.unknown', {
  fallback: [
    "I don't know anything about {name}.",
    'Never met {name}.',
    '{name} is a mystery to me.',
    'No idea who {name} is.',
    "{name}? Not someone I've had the pleasure of.",
    "Can't help you with {name}, never seen 'em talk.",
    "I'd need {name} to say something first.",
    "{name} hasn't been introduced to me.",
    'Got no file on {name}.',
    "{name}? Haven't had the honour.",
    "Who? {name}? You're gonna have to point 'em out.",
    "I only keep tabs on people who've spoken up. {name} hasn't."
  ],
  professional: ["I don't know anything about {name} yet.", "{name} hasn't said anything I've seen yet."],
  rare: [
    '{name} is either brand new or a ghost. 👻',
    "Ain't nobody by the name of {name} on my payroll."
  ]
})


export default async (robot: Robot) => {
  // anyone in casual rooms; manage roles in professional ones
  const mayEdit = async (res: Response): Promise<boolean> => {
    if (policyFor(robot).modeOf(res.message.room, res.message.user?.message as RawLike | undefined) === 'casual' || canManage(res, 'roles')) return true
    await res.send(MANAGE_ONLY.roles)
    return false
  }

  robot.respond(/who is @?([\w .-]+)\?*$/i, { id: 'roles.who' }, async res => {
    const joiner = ', '
    const name = required(res.match, 1).trim()
    if (RESERVED.test(name)) return

    if (name === 'you') {
      await res.send("Who ain't I?")
    } else if (name === robot.name) {
      await res.send('The best.')
    } else {
      const store = storeOf(robot, res)
      const users = findPeople(robot, store.space, name)
      const user = users.length === 1 ? users[0] : undefined
      if (user) {
        const roles = rolesIn(store)[user.id] ?? []
        if (roles.length > 0) {
          const j = roles.join('').includes(',') ? '; ' : joiner
          await res.send(`${name} is ${roles.join(j)}.`)
        } else {
          await res.send(nothingToMe({ name }, { room: res.message.room, tz: userTz(robot, res.message.user.id) }))
        }
      } else if (users.length > 1) {
        await res.send(getAmbiguousUserText(users))
      } else {
        await res.send(neverHeard({ name }, { room: res.message.room, tz: userTz(robot, res.message.user.id) }))
      }
    }
  })

  robot.respond(/@?([\w .\-_]+) is (["'\w: -_]+)[.!]*$/i, { id: 'roles.add' }, async res => {
    const name = required(res.match, 1).trim()
    const newRole = required(res.match, 2).trim()

    if (skipNames.includes(name.toLowerCase()) || notAName(name) || newRole.match(/^not\s+/i)) {
      return
    }
    if (!await mayEdit(res)) return

    const store = storeOf(robot, res)
    const users = findPeople(robot, store.space, name)
    const user = users.length === 1 ? users[0] : undefined
    if (user) {
      const roles = rolesIn(store)[user.id] ?? []

      if (roles.includes(newRole)) {
        await res.send('I know')
      } else {
        setRoles(store, user.id, [...roles, newRole])
        if (name.toLowerCase() === robot.name.toLowerCase()) {
          await res.send(`Ok, I am ${newRole}.`)
        } else {
          await res.send(`Ok, ${name} is ${newRole}.`)
        }
      }
    } else if (users.length > 1) {
      await res.send(getAmbiguousUserText(users))
    } else {
      await res.send(unknownUser({ name }, { room: res.message.room, tz: userTz(robot, res.message.user.id) }))
    }
  })

  robot.respond(/@?([\w .\-_]+) is not (["'\w: -_]+)[.!]*$/i, { id: 'roles.remove' }, async res => {
    const name = required(res.match, 1).trim()
    const newRole = required(res.match, 2).trim()

    if (skipNames.includes(name.toLowerCase()) || notAName(name)) {
      return
    }
    if (!await mayEdit(res)) return

    const store = storeOf(robot, res)
    const users = findPeople(robot, store.space, name)
    const user = users.length === 1 ? users[0] : undefined
    if (user) {
      const roles = rolesIn(store)[user.id] ?? []

      if (!roles.includes(newRole)) {
        await res.send('I know.')
      } else {
        setRoles(store, user.id, roles.filter(role => role !== newRole))
        await res.send(`Ok, ${name} is no longer ${newRole}.`)
      }
    } else if (users.length > 1) {
      await res.send(getAmbiguousUserText(users))
    } else {
      await res.send(unknownUser({ name }, { room: res.message.room, tz: userTz(robot, res.message.user.id) }))
    }
  })
}
