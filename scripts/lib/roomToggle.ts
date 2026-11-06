import type { Robot } from 'hubot'

interface DisabledBy {
  by: string
  at: number
}

interface ToggleOptions {
  // command word, e.g. `reactions`
  command: string
  brainKey: string
  // plural noun shown to people, e.g. `Emoji reactions`
  label: string
  // appended to the status reply
  details?: (room: string) => string
}

export interface RoomToggle {
  isDisabled: (room: string) => boolean
}

// registers `hubot <command> [on|off|status]`, stored per room in the brain
export const roomToggle = (robot: Robot, { command, brainKey, label, details }: ToggleOptions): RoomToggle => {
  const disabledRooms = (): Record<string, DisabledBy> => {
    const stored = robot.brain.get(brainKey)
    return typeof stored === 'object' && stored !== null ? stored as Record<string, DisabledBy> : {}
  }

  robot.respond(new RegExp(`${command}(?: (on|off|status))?$`, 'i'), async res => {
    const room = res.message.room
    const action = (res.match[1] || 'status').toLowerCase()
    const rooms = disabledRooms()

    if (action === 'off') {
      robot.brain.set(brainKey, { ...rooms, [room]: { by: res.message.user.name, at: Date.now() } })
      await res.send(`${label} off in this channel. \`${robot.name} ${command} on\` brings them back.`)
    } else if (action === 'on') {
      const { [room]: _, ...rest } = rooms
      robot.brain.set(brainKey, rest)
      await res.send(`${label} on in this channel.`)
    } else {
      const disabled = rooms[room]
      const status = disabled
        ? `${label} are off in this channel (turned off by ${disabled.by} on ${new Date(disabled.at).toISOString().slice(0, 10)}).`
        : `${label} are on in this channel.`
      await res.send(details ? `${status} ${details(room)}` : status)
    }
  })

  return { isDisabled: room => room in disabledRooms() }
}

// message starts with the bot's name or alias
export const addressesBot = (robot: Robot, text: string): boolean => {
  const names = [robot.name, robot.alias].filter((n): n is string => Boolean(n)).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^\\s*@?(?:${names.join('|')})\\b`, 'i').test(text)
}
