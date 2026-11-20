import type { Robot } from 'hubot'

// addressed to the bot
export const addressesBot = (robot: Robot, text: string): boolean => {
  const names = [robot.name, robot.alias].filter((n): n is string => Boolean(n)).map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^\\s*@?(?:${names.join('|')})\\b`, 'i').test(text)
}
