// Description:
//   Keeps donbot's lines fresh: no repeats until a list is used up, a reserve of Gemini-written
//   lines mixed in, rare surprise lines, and reactions that teach it which lines land.
//   Positive reactions on a bot line (😂 💀 😭 🔥 🐐 ❤️ …) make it more likely, and good AI lines are kept for good;
//   negative ones (🙄 👎 🤡 🧢 😬 …) retire it. See lib/reactions.ts.
//
// Commands:
//   hubot ai lines - Shows whether AI-written lines are on in this channel.
//   hubot ai lines off - Uses only the built-in lines in this channel.
//   hubot ai lines on - Mixes AI-written lines back in.
//   hubot whimsy - Shows how many fresh, kept and retired lines each kind has.
//   hubot whimsy refill - (Owner only) Tops up every AI line reserve now.
//
// Configuration:
//   GEMINI_API_KEY - Needed for AI-written lines; without it only built-in lines are used.
//   GEMINI_LINE_MODELS - Comma-separated models to try in order. Defaults to gemini-flash-latest, gemini-flash-lite-latest, gemini-2.5-flash-lite.
//   GEMINI_LINE_DAILY_CALLS - Most Gemini requests per day for lines. Defaults to 20, to stay well inside the free tier.
//   OWNER_USER_ID - Discord user ID allowed to run whimsy refill.
//

import type { Robot, DiscordReaction, DiscordUser } from 'hubot'

import { AI_DAILY_CALLS, aiCallsToday, aiKinds, configureLines, keptFor, lineKinds, linesIn, poolFor, refillAi, RETIRE_SCORE, scoreLine, scoresFor, useLines } from './lib/lines.ts'
import { valenceOf } from './lib/reactions.ts'
import { roomToggle } from './lib/roomToggle.ts'


export default async (robot: Robot) => {
  robot.brain.on('connected', () => useLines(robot))

  const { isDisabled } = roomToggle(robot, { command: 'ai lines', brainKey: 'lines:ai-off', label: 'AI-written lines' })
  configureLines({ aiAllowed: room => !room || !isDisabled(room) })

  // user:message, so each person counts once per message
  const counted = new Set<string>()

  const client = robot.adapter && robot.adapter.client
  if (client && typeof client.on === 'function') {
    const onReaction = (sign: 1 | -1) => async (reaction: DiscordReaction, user: DiscordUser) => {
      if (user.bot) return
      const emoji = reaction.emoji.name
      const delta = valenceOf(emoji)
      if (!delta) return
      try {
        if (reaction.partial) await reaction.fetch()
      } catch {
        return
      }
      const message = reaction.message
      const botId = client.user?.id
      if (!message.author || message.author.id !== botId || !message.content) return
      const key = `${user.id}:${message.id}:${emoji}`
      if (sign > 0 ? counted.has(key) : !counted.has(key)) return
      if (sign > 0) counted.add(key)
      else counted.delete(key)
      if (counted.size > 5000) counted.clear()
      for (const ref of linesIn(message.content)) scoreLine(ref, sign * delta)
    }
    client.on('messageReactionAdd', onReaction(1))
    client.on('messageReactionRemove', onReaction(-1))
  }

  robot.respond(/whimsy$/i, async res => {
    const stats = lineKinds().map(kind => ({
      kind,
      fresh: aiKinds().includes(kind) ? poolFor(kind).lines.length : 0,
      kept: keptFor(kind).length,
      retired: Object.values(scoresFor(kind)).filter(s => s <= RETIRE_SCORE).length
    }))
    const sum = (field: 'fresh' | 'kept' | 'retired') => stats.reduce((n, s) => n + s[field], 0)
    const head = `✨ ${stats.length} kinds of lines, ${aiKinds().length} with AI help: ${sum('fresh')} fresh AI lines waiting, ${sum('kept')} kept, ${sum('retired')} retired.`
    const rows = stats.filter(s => s.fresh || s.kept || s.retired)
      .map(s => `• ${s.kind}: ${s.fresh} fresh, ${s.kept} kept, ${s.retired} retired`)
    const ai = process.env.GEMINI_API_KEY
      ? `\n${aiCallsToday()} of ${Number(process.env.GEMINI_LINE_DAILY_CALLS) || AI_DAILY_CALLS} Gemini requests used today.`
      : '\n(No GEMINI_API_KEY, so built-in lines only.)'
    await res.send([head, ...rows].join('\n') + ai)
  })

  robot.respond(/whimsy refill$/i, async res => {
    if (res.message.user.id !== process.env.OWNER_USER_ID) {
      await res.send('Only my owner can do that.')
      return
    }
    if (!process.env.GEMINI_API_KEY) {
      await res.send('No GEMINI_API_KEY set.')
      return
    }
    // one at a time, to stay inside free-tier rate limits
    let added = 0
    for (const kind of aiKinds()) added += await refillAi(kind, { force: true })
    await res.send(`Added ${added} fresh lines across ${aiKinds().length} kinds. ${aiCallsToday()} of ${Number(process.env.GEMINI_LINE_DAILY_CALLS) || AI_DAILY_CALLS} Gemini requests used today.`)
  })
}
