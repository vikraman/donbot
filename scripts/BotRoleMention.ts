// Description:
//   Treats a mention of the bot's own role, which discord's @ autocomplete offers next to the bot, as addressing the bot.
//

import type { Robot, TextMessage } from 'hubot'

const ROLE_MENTION = /^<@&(\d+)>\s*/

export default async (robot: Robot) => {
  const receive = robot.receive.bind(robot)
  // wraps receive so it runs before every middleware, whatever the load order
  robot.receive = (message: TextMessage) => {
    const m = typeof message.text === 'string' ? message.text.match(ROLE_MENTION) : null
    const botId = robot.adapter.client?.user?.id
    const role = m && message.user?.message?.mentions?.roles?.get(m[1] as string)
    if (m && botId && role?.tags?.botId === botId) message.text = `@${robot.name} ${message.text.slice(m[0].length)}`
    return receive(message)
  }
}
