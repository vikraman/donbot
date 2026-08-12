// Renders a Discord-style @mention for a brain user record ({id, name}).
// <@id> is rendered by Discord as a live, clickable @username that stays
// correct even if the person renames themselves; falls back to a plain
// "@name" when there's no known Discord id.
export const mentionFor = user =>
  user && user.id ? `<@${user.id}>` : `@${(user && user.name) || 'unknown'}`
