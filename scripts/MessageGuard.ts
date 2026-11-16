// Description:
//   Guards every message in and out. Discord re-sends a message when it's edited or a link preview
//   loads; repeats are dropped, except an edit to a message no command picked up (a fixed typo).
//   Outgoing messages may only ping users, never @everyone, @here or roles. Discord only.
//

import type { Robot } from 'hubot'

// message ids remembered for repeat detection
export const SEEN_LIMIT = 5000

interface Seen {
  text: string
  // a command (not a hear-everything listener) acted on it
  handled: boolean
}

// listeners that hear every message don't count as handling it
const isCatchAll = (regex: unknown): boolean => regex instanceof RegExp && regex.test('')

export default async (robot: Robot) => {
  const client = robot.adapter && robot.adapter.client
  if (client && typeof client === 'object') {
    // discord.js uses this when a send doesn't say otherwise
    const options = (client as { options?: Record<string, unknown> }).options
    if (options) options.allowedMentions = { parse: ['users'], repliedUser: true }
  }

  const seen = new Map<string, Seen>()

  robot.receiveMiddleware(async ({ response }) => {
    const { id, text } = response.message
    if (id === undefined || id === null || typeof text !== 'string') return true
    const key = String(id)
    const before = seen.get(key)
    if (before && (before.text === text || before.handled)) return false
    seen.delete(key)
    seen.set(key, { text, handled: false })
    if (seen.size > SEEN_LIMIT) seen.delete(seen.keys().next().value!)
    return true
  })

  robot.listenerMiddleware(async ({ listener, response }) => {
    const id = response.message.id
    const entry = id === undefined || id === null ? undefined : seen.get(String(id))
    if (entry && !isCatchAll(listener.regex)) entry.handled = true
    return true
  })
}
