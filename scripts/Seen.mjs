// Description:
//   Tracks when each user was last seen.
//
// Commands:
//   hubot seen <user> - Shows when <user> was last seen.
//

const seenKey = userId => `seen:${userId}`

export default async (robot) => {
  robot.hear(/.*/, async res => {
    const user = res.message.user
    if (user && user.id != null) {
      robot.brain.set(seenKey(user.id), { name: user.name, time: Date.now() })
    }
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
    await res.send(`${entry.name} was last seen ${new Date(entry.time).toISOString()}`)
  })
}
