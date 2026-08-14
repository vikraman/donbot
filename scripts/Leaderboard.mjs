// Description:
//   Shows the top plusplus scores.
//
// Commands:
//   hubot leaderboard - Shows the top 10 plusplus scores.
//

import { pick, chance } from './lib/random.mjs'

const PREFIX = 'plusplus:'

const TOP_COMMENTS = [
  '{thing} is untouchable right now.',
  'All hail {thing}.',
  "Nobody's catching {thing} at this rate.",
  '{thing} really is built different.'
]

const BOTTOM_COMMENTS = [
  "{thing} is really struggling down here.",
  'Rough day for {thing}.',
  "{thing} needs some love.",
  'Someone go check on {thing}.'
]

const COMMENT_CHANCE = 0.5

const fillTemplate = (template, thing) => template.replace('{thing}', thing)

export default async (robot) => {
  robot.respond(/(?:leaderboard|top scores|high scores|rankings)$/i, async res => {
    const data = robot.brain.data._private || {}
    const scores = Object.keys(data)
      .filter(key => key.startsWith(PREFIX))
      .map(key => ({ thing: key.slice(PREFIX.length), score: data[key] }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    if (scores.length === 0) {
      await res.send('No scores yet.')
      return
    }

    const lines = scores.map((s, i) => `${i + 1}. ${s.thing}: ${s.score}`)

    if (chance(COMMENT_CHANCE)) {
      lines.push('')
      lines.push(fillTemplate(pick(TOP_COMMENTS), scores[0].thing))
    }
    if (scores.length > 1 && chance(COMMENT_CHANCE)) {
      lines.push(fillTemplate(pick(BOTTOM_COMMENTS), scores[scores.length - 1].thing))
    }

    await res.send(lines.join('\n'))
  })
}
