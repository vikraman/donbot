import type { Robot } from 'hubot'

// robot.messageRoom only finds cached channels, and dms aren't cached again after a restart
export const postToRoom = async (robot: Robot, room: string, text: string): Promise<unknown> => {
  const channels = robot.adapter.client?.channels
  if (channels?.cache && !channels.cache.get(room) && channels.fetch) {
    try {
      // fetching caches it for the adapter's send
      await channels.fetch(room)
    } catch (error) {
      robot.logger.warn(`rooms: couldn't fetch channel ${room}: ${String(error)}`)
    }
  }
  return robot.messageRoom(room, text)
}
