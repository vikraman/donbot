import type { Response, DiscordMessage } from 'hubot'

// raw discord.js message, if the adapter attached one
export const rawMessageOf = (res: Response): DiscordMessage | undefined => res.message.user && res.message.user.message
