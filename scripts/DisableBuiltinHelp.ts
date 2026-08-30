// Description:
//   Unregisters core's "help" so hubot-help's comment-scraped listing runs instead.
//   Core's help uses rigid --flags and shadows other help handlers via middleware.
//

import type { Robot } from 'hubot'

export default async (robot: Robot) => {
  robot.commands.unregister('help')
}
