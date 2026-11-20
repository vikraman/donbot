// Description:
//   Unregisters core's "help" so the policy-filtered help in Policy.ts runs instead.
//   Core's help uses rigid --flags, shadows other help handlers and would skip the gate.
//

import type { Robot } from 'hubot'

export default async (robot: Robot) => {
  robot.commands.unregister('help')
}
