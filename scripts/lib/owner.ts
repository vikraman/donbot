import type { Response } from 'hubot'

// OWNER_USER_ID, when set
export const isOwnerId = (id: string | undefined): boolean => Boolean(process.env.OWNER_USER_ID) && id === process.env.OWNER_USER_ID

export const isOwner = (res: Response): boolean => isOwnerId(res.message.user.id)

export const OWNER_ONLY = 'Only my owner can do that.'
