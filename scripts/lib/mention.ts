interface MentionTarget {
  id?: string
  name?: string
}

// <@id> is clickable in discord; else plain @name
export const mentionFor = (user?: MentionTarget): string =>
  user && user.id ? `<@${user.id}>` : `@${(user && user.name) || 'unknown'}`
