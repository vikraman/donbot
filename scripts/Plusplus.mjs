// Description:
//   Give or take away points to/from things.
//
// Commands:
//   <thing>++ - Increments points for <thing>.
//   <thing>-- - Decrements points for <thing>.
//   hubot score for <thing> - Shows points for <thing>.
//

const scoreKey = thing => `plusplus:${thing.toLowerCase()}`

export default async (robot) => {
  robot.hear(/^\s*([\w .-]+?)\s*(\+\+|--)\s*$/, async res => {
    const thing = res.match[1].trim()
    const delta = res.match[2] === '++' ? 1 : -1
    const key = scoreKey(thing)
    const score = (robot.brain.get(key) || 0) + delta
    robot.brain.set(key, score)
    await res.send(`${thing}: ${score}`)
  })

  robot.respond(/(?:score for|points for|how many points does) ([\w .-]+?) ?(?:have)?\s*$/i, async res => {
    const thing = res.match[1].trim()
    const score = robot.brain.get(scoreKey(thing)) || 0
    await res.send(`${thing}: ${score}`)
  })
}
