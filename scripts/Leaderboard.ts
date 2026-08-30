// Description:
//   Shows the top plusplus scores.
//
// Commands:
//   hubot leaderboard - Shows the top 10 plusplus scores.
//

import type { Robot } from 'hubot'

import { entriesWithPrefix, isScore } from './lib/brainScan.ts'
import { pick, chance } from './lib/random.ts'

const PREFIX = 'plusplus:'

const TOP_COMMENTS = [
  '{thing} is untouchable right now.',
  'All hail {thing}.',
  "Nobody's catching {thing} at this rate.",
  '{thing} really is built different.'
] as const

const BOTTOM_COMMENTS = [
  "{thing} is really struggling down here.",
  'Rough day for {thing}.',
  "{thing} needs some love.",
  'Someone go check on {thing}.'
] as const

const COMMENT_CHANCE = 0.5

const fillTemplate = (template: string, thing: string): string => template.replace('{thing}', thing)

export default async (robot: Robot) => {
  robot.respond(/(?:leaderboard|top scores|high scores|rankings)$/i, async res => {
    const scores = entriesWithPrefix(robot, PREFIX, isScore)
      .map(([thing, score]) => ({ thing, score }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)

    if (scores.length === 0) {
      await res.send('No scores yet.')
      return
    }

    const lines = scores.map((s, i) => `${i + 1}. ${s.thing}: ${s.score}`)

    const top = scores[0]
    const bottom = scores[scores.length - 1]

    if (top && chance(COMMENT_CHANCE)) {
      lines.push('')
      lines.push(fillTemplate(pick(TOP_COMMENTS), top.thing))
    }
    if (bottom && scores.length > 1 && chance(COMMENT_CHANCE)) {
      lines.push(fillTemplate(pick(BOTTOM_COMMENTS), bottom.thing))
    }

    await res.send(lines.join('\n'))
  })
}
