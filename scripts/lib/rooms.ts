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

// cached or fetched channel
export const channelOf = async <T>(robot: Robot, room: string): Promise<T | undefined> => {
  const channels = robot.adapter.client?.channels
  return (channels?.cache?.get(room) ?? await channels?.fetch?.(room) ?? undefined) as T | undefined
}

export interface FileOut {
  data: Uint8Array
  name: string
}

interface FileChannel {
  send?: (o: { content: string, files: { attachment: Buffer, name: string }[], allowedMentions: { parse: string[], repliedUser: boolean }, reply?: { messageReference: string, failIfNotExists: boolean } }) => Promise<unknown>
}

// files or reply, else text
export const postFiles = async (robot: Robot, room: string, text: string, files: FileOut[], { feature, replyTo }: { feature?: string, replyTo?: string } = {}): Promise<unknown> => {
  if (feature && !await allowsRoomAsync(robot, room, feature)) return undefined
  if (files.length || replyTo) {
    try {
      const channel = await channelOf<FileChannel>(robot, room)
      if (channel?.send) {
        return await channel.send({
          content: text,
          files: files.map(f => ({ attachment: Buffer.from(f.data), name: f.name })),
          allowedMentions: { parse: [], repliedUser: false },
          ...replyTo ? { reply: { messageReference: replyTo, failIfNotExists: false } } : {}
        })
      }
    } catch (error) {
      robot.logger.warn(`rooms: couldn't send files in ${room}: ${String(error)}`)
    }
  }
  return postToRoom(robot, room, files.length ? `${text}\n(couldn't attach the images)` : text)
}
