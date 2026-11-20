import type { Robot } from 'hubot'

import { allowsRoomAsync } from './policy.ts'

// robot.messageRoom only finds cached channels, and dms aren't cached again after a restart
// skipped if the feature is off by now
export const postToRoom = async (robot: Robot, room: string, text: string, feature?: string): Promise<unknown> => {
  if (feature && !await allowsRoomAsync(robot, room, feature)) return undefined
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
