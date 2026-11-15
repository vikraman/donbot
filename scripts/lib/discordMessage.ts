import type { Response, DiscordMessage } from 'hubot'

// raw discord.js message, if the adapter attached one
export const rawMessageOf = (res: Response): DiscordMessage | undefined => res.message.user && res.message.user.message

// ids of messages the adapter sent; send is typed void but returns them
export const sentIds = (sent: unknown): string[] =>
  Array.isArray(sent) ? sent.map(m => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === 'string') : []
