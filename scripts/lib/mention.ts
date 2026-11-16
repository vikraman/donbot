interface MentionTarget {
  id?: string
  name?: string
}

// <@id> is clickable in discord; else plain @name, defused so "everyone" or "<@&role>" can't ping
export const mentionFor = (user?: MentionTarget): string =>
  user && user.id ? `<@${user.id}>` : `@\u200b${((user && user.name) || 'unknown').replace(/[<>]/g, '')}`
