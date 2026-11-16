import type { Response } from 'hubot'

// OWNER_USER_ID, when set
export const isOwner = (res: Response): boolean => Boolean(process.env.OWNER_USER_ID) && res.message.user.id === process.env.OWNER_USER_ID

export const OWNER_ONLY = 'Only my owner can do that.'
