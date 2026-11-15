import { cooldown } from './cooldown.ts'
import { sentIds } from './discordMessage.ts'

const MAX_SEEN = 1000
const MAX_OWN = 200

export interface ReactionGuard {
  // true the first time this user reacts to this message
  first: (messageId: string, userId: string) => boolean
  // false for our own replies and within the channel cooldown
  mayReply: (messageId: string, channelId: string) => boolean
  // marks sent messages as our own replies
  remember: (sent: unknown) => void
}

// insertion-ordered set, oldest dropped past the cap
const addCapped = (set: Set<string>, key: string, cap: number) => {
  set.add(key)
  if (set.size > cap) set.delete(set.values().next().value!)
}

// keeps reaction-triggered replies from being spammed or chained
export const reactionGuard = (replyCooldownMs: number): ReactionGuard => {
  const seen = new Set<string>()
  const own = new Set<string>()
  const replies = cooldown(replyCooldownMs)

  return {
    first: (messageId, userId) => {
      const key = `${messageId}:${userId}`
      if (seen.has(key)) return false
      addCapped(seen, key, MAX_SEEN)
      return true
    },
    mayReply: (messageId, channelId) => !own.has(messageId) && replies.take(channelId),
    remember: sent => {
      for (const id of sentIds(sent)) addCapped(own, id, MAX_OWN)
    }
  }
}
