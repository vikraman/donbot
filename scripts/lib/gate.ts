import type { ListenerMiddlewareContext, Robot, TextMessage } from 'hubot'

import { listenerId } from './features.ts'
import { policyFor } from './policy.ts'
import { isWebRoom } from './web.ts'

// policy gate for every listener

const HINT_EVERY_MS = 60 * 1000

interface Seen {
  // blocked feature to hint
  blocked?: string
  answered: boolean
}

const installed = new WeakSet<Robot>()

const isRespond = (robot: Robot, regex: RegExp | undefined): boolean =>
  Boolean(regex && regex.source.startsWith('^\\s*[@]?') && regex.source.toLowerCase().includes(robot.name.toLowerCase()))

export const installGate = (robot: Robot) => {
  if (installed.has(robot)) return
  installed.add(robot)
  const policy = policyFor(robot)
  const seen = new WeakMap<object, Seen>()
  const hinted = new Map<string, number>()

  const gate = async ({ listener, response }: ListenerMiddlewareContext): Promise<boolean> => {
    // never throw, hubot fails open
    try {
      const id = listenerId(listener)
      // no id: blocked, no hint
      const off: { id: string, level?: string } | undefined = id ? policy.blockedBy(response, id) : { id: '' }
      const respond = isRespond(robot, listener.regex)
      const entry = seen.get(response.message) ?? { answered: false }
      seen.set(response.message, entry)
      if (!off) {
        if (respond) entry.answered = true
        return true
      }
      if (respond && off.id && off.level !== 'mature' && listener.options?.hint !== false && !entry.blocked) entry.blocked = off.id
      return false
    } catch (err) {
      robot.logger.error(`gate: ${err instanceof Error ? err.message : String(err)}`)
      return false
    }
  }
  robot.listenerMiddleware(gate)
  // first in the stack
  const stack = (robot as unknown as { middleware: { listener: { stack: unknown[] } } }).middleware.listener.stack
  stack.unshift(stack.pop())

  // hint once if blocked and unanswered
  const receive = robot.receive.bind(robot)
  robot.receive = async (message: TextMessage) => {
    const result = await receive(message)
    const entry = seen.get(message)
    const room = message.room
    if (!entry?.blocked || entry.answered || !room || isWebRoom(room)) return result
    const now = Date.now()
    if (now - (hinted.get(room) ?? 0) < HINT_EVERY_MS) return result
    // prune expired
    for (const [r, at] of hinted) if (now - at >= HINT_EVERY_MS) hinted.delete(r)
    hinted.set(room, now)
    const resolved = policy.resolve(room, message.user?.message as never)
    const server = Boolean(resolved.serverOff?.includes(entry.blocked))
    const who = resolved.scope.kind === 'dm' ? 'You can' : `Someone who can manage this ${server ? 'server' : 'channel'} can`
    try {
      await robot.messageRoom(room, `That isn't enabled here. ${who} turn it on with \`${robot.name} ${server ? 'reset' : 'enable'} ${entry.blocked}${server ? ' server' : ''}\`.`)
    } catch (err) {
      robot.logger.error(`gate hint: ${err instanceof Error ? err.message : String(err)}`)
    }
    return result
  }
}
