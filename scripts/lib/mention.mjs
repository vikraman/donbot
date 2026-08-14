// <@id> renders as a live clickable mention in Discord; falls back to plain @name
export const mentionFor = user =>
  user && user.id ? `<@${user.id}>` : `@${(user && user.name) || 'unknown'}`
