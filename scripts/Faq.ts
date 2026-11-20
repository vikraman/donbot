// Description:
//   Short answers saved once and recalled by name, per server.
//
// Commands:
//   hubot faq <name> - Shows the saved answer for <name>.
//   hubot faqs - Lists the saved answers here.
//   hubot faq <name> is <answer> - Saves an answer, replacing any old one (Manage Channels).
//   hubot forget faq <name> - Removes an answer (Manage Channels).
//

import type { Robot } from 'hubot'

import { defineFeature } from './lib/features.ts'
import { required } from './lib/match.ts'
import { canManage, MANAGE_ONLY } from './lib/permissions.ts'
import { storeOf, type SpaceStore } from './lib/spaces.ts'

defineFeature({ id: 'faq', label: 'FAQ answers', level: 'professional', help: ['hubot faq', 'hubot forget faq'] })

interface Answer {
  text: string
  by: string
  at: number
}

const FAQ_KEY = 'faq'
export const MAX_ANSWERS = 100
const MAX_TEXT = 1500
const NAME = String.raw`([\w.-]{1,40})`

const answersIn = (store: SpaceStore): Record<string, Answer> => {
  const stored = store.get(FAQ_KEY)
  return typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? stored as Record<string, Answer> : {}
}

export default async (robot: Robot) => {
  robot.respond(new RegExp(String.raw`faq ${NAME} is ([\s\S]+)$`, 'i'), { id: 'faq.save' }, async res => {
    if (!canManage(res, 'channel')) {
      await res.send(MANAGE_ONLY.channel)
      return
    }
    const name = required(res.match, 1).toLowerCase()
    const store = storeOf(robot, res)
    const answers = answersIn(store)
    if (!answers[name] && Object.keys(answers).length >= MAX_ANSWERS) {
      await res.send(`There are already ${MAX_ANSWERS} answers here. Forget some first.`)
      return
    }
    const text = required(res.match, 2).trim().slice(0, MAX_TEXT)
    store.set(FAQ_KEY, { ...answers, [name]: { text, by: res.message.user.id, at: Date.now() } })
    await res.send(`Saved \`${name}\`. \`${robot.name} faq ${name}\` shows it.`)
  })

  robot.respond(new RegExp(String.raw`faq ${NAME}$`, 'i'), { id: 'faq.show' }, async res => {
    const name = required(res.match, 1).toLowerCase()
    const answer = answersIn(storeOf(robot, res))[name]
    await res.send(answer ? answer.text : `There's no answer called \`${name}\`. \`${robot.name} faqs\` lists them.`)
  })

  robot.respond(/faqs$/i, { id: 'faq.list' }, async res => {
    const names = Object.keys(answersIn(storeOf(robot, res))).sort()
    await res.send(names.length ? `Saved answers: ${names.map(n => `\`${n}\``).join(', ')}` : `No saved answers here yet.`)
  })

  robot.respond(new RegExp(String.raw`forget faq ${NAME}$`, 'i'), { id: 'faq.forget' }, async res => {
    if (!canManage(res, 'channel')) {
      await res.send(MANAGE_ONLY.channel)
      return
    }
    const name = required(res.match, 1).toLowerCase()
    const store = storeOf(robot, res)
    const { [name]: gone, ...rest } = answersIn(store)
    if (!gone) {
      await res.send(`There's no answer called \`${name}\`.`)
      return
    }
    store.set(FAQ_KEY, rest)
    await res.send(`Forgot \`${name}\`.`)
  })
}
