// Description:
//   Ask the magic 8-ball a question.
//
// Commands:
//   hubot 8ball <question> - Answers a yes/no question.
//

import { pick } from './lib/random.mjs'

const answers = [
  'It is certain.',
  'It is decidedly so.',
  'Without a doubt.',
  'Yes, definitely.',
  'You may rely on it.',
  'As I see it, yes.',
  'Most likely.',
  'Outlook good.',
  'Yes.',
  'Signs point to yes.',
  'Reply hazy, try again.',
  'Ask again later.',
  'Better not tell you now.',
  'Cannot predict now.',
  'Concentrate and ask again.',
  "Don't count on it.",
  'My reply is no.',
  'My sources say no.',
  'Outlook not so good.',
  'Very doubtful.'
]

export default async (robot) => {
  robot.respond(/(?:8ball|8-ball|magic 8 ?ball)\s+(.+)$/i, async res => {
    await res.send(pick(answers))
  })
}
