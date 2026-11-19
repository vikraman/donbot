// rooms and user ids of web chat visitors
export const WEB_PREFIX = 'web:'

export const isWebRoom = (room: unknown): boolean => typeof room === 'string' && room.startsWith(WEB_PREFIX)
