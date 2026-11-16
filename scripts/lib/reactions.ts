// shared reaction meanings; ⭐ is left out because StarReact owns it

// thanks, love, hype, respect
export const APPROVAL: ReadonlySet<string> = new Set([
  '👍', '👌', '👏', '🙌', '🙏', '💪', '🫡', '🤌', '🤙', '✌️', '🤝', '🫶', '🥰', '😍', '🤩', '😎', '🥹', '😊', '☺️', '😇', '🤗',
  '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '🩷', '🩵', '💖', '💕', '💗', '💓', '💞', '💘', '💝', '❤️‍🔥', '😻',
  '🎉', '🥳', '🎊', '🍾', '🥂', '🎈', '✨', '🌟', '💫', '⚡', '🔥', '💯', '🚀', '💥',
  '🏆', '🥇', '🎖️', '🏅', '👑', '💎', '💐', '🌹', '🌸',
  '🐐', '💅', '🧠', '🤯', '🎯', '💡', '✅', '☑️', '✔️', '🆒', '🔝', '📈', '🙇', '🦾', '🍻', '🍰', '🧁'
])

// funny; 💀 ☠️ 😭 mean "i'm dying" these days
export const LAUGH: ReadonlySet<string> = new Set([
  '😂', '🤣', '😆', '😹', '😄', '😁', '😅', '😀', '😃', '😸', '🙃', '😜', '😝', '😛', '🤪', '😏', '🤭',
  '💀', '☠️', '😭', '🥁', '🍿', '🫢'
])

export const POSITIVE: ReadonlySet<string> = new Set([...APPROVAL, ...LAUGH])

// boo, cringe, cap, sus, sad, angry, bored
export const NEGATIVE: ReadonlySet<string> = new Set([
  '👎', '🙄', '😒', '😑', '😐', '🫤', '😕', '🤨', '🧐', '😬', '🫠', '🥴', '😶', '🫥', '😶‍🌫️',
  '🤦', '🤷', '🥱', '😴', '💤', '🍅', '🗑️', '💩', '🤡', '🧢', '🚩', '📉', '❌', '🚫', '⛔', '🛑',
  '😢', '😞', '😔', '😟', '🙁', '☹️', '😩', '😫', '😖', '😣', '😿', '💔', '🥀',
  '😡', '😠', '🤬', '👿', '🤢', '🤮', '🤧', '😵', '😵‍💫', '🙅', '🫣'
])

// skin tones, gender signs and variation selectors don't change the meaning
export const baseEmoji = (emoji: string): string =>
  emoji
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '')
    .replace(/\u200D[\u2640\u2642]\uFE0F?/g, '')
    .replace(/\uFE0F/g, '')

const normalize = (set: ReadonlySet<string>): ReadonlySet<string> => new Set([...set].map(baseEmoji))

const APPROVAL_BASE = normalize(APPROVAL)
const POSITIVE_BASE = normalize(POSITIVE)
const NEGATIVE_BASE = normalize(NEGATIVE)

export const isApproval = (emoji: string): boolean => APPROVAL_BASE.has(baseEmoji(emoji))

// 1 for positive (approval or laughter), -1 for negative, 0 otherwise
export const valenceOf = (emoji: string): 1 | -1 | 0 => {
  const base = baseEmoji(emoji)
  if (POSITIVE_BASE.has(base)) return 1
  if (NEGATIVE_BASE.has(base)) return -1
  return 0
}
