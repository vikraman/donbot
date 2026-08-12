// Description:
//   Shows the top plusplus scores.
//
// Commands:
//   hubot leaderboard - Shows the top 10 plusplus scores.
//

const PREFIX = 'plusplus:'

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
    await res.send(lines.join('\n'))
  })
}
