// Description:
//   Persists a counter in the robot brain to verify redis-brain works.
//
// Commands:
//   hubot count - Increments and returns the counter.
//

export default async (robot) => {
  robot.respond(/count$/, async res => {
    const count = (robot.brain.get('count') || 0) + 1
    robot.brain.set('count', count)
    await res.reply(`Count is now ${count}`)
  })
}
