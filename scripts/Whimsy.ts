// Description:
//   Keeps donbot's lines fresh: no repeats until a list is used up, a reserve of Gemini-written
//   lines mixed in, rare surprise lines, and reactions that teach it which lines land.
//   Positive reactions on a bot line (😂 💀 😭 🔥 🐐 ❤️ …) make it more likely, and good AI lines are kept for good;
//   negative ones (🙄 👎 🤡 🧢 😬 …) retire it. See lib/reactions.ts.
//
// Commands:
//   hubot whimsy - Shows how many fresh, kept and retired lines each kind has.
//   hubot whimsy refill - (Owner only) Tops up every AI line reserve now.
//
// Configuration:
//   GEMINI_API_KEY - Needed for AI-written lines; without it only built-in lines are used.
//   GEMINI_MODELS - Comma-separated models to try in turn (shared with ask). Defaults to gemini-flash-latest, gemini-flash-lite-latest, gemini-2.5-flash-lite.
//   GEMINI_LINE_DAILY_CALLS - Most Gemini requests per day for lines. Defaults to 20, to stay well inside the free tier.
//   OWNER_USER_ID - Discord user ID allowed to run whimsy refill.
//

import type { Robot, DiscordReaction, DiscordUser } from 'hubot'

import { AI_DAILY_CALLS, aiCallsToday, aiKinds, keptFor, lineKinds, linesIn, poolFor, refillAi, RETIRE_SCORE, scoreLine, scoresFor, useLines } from './lib/lines.ts'
import { valenceOf } from './lib/reactions.ts'
import { defineFeature } from './lib/features.ts'
import { isOwner, OWNER_ONLY } from './lib/owner.ts'
import { allowsRoom } from './lib/policy.ts'

defineFeature({ id: 'whimsy', label: 'Line stats', level: 'professional', help: ['hubot whimsy'] })
defineFeature({ id: 'lines.scoring', label: 'Learning from reactions', level: 'professional', passive: true, stores: "reactions to the bot's own lines, as scores per line" })


export default async (robot: Robot) => {
  robot.brain.on('connected', () => useLines(robot))


  // user:message -> their scoring emoji; each person is one vote per message, whatever they react with
  const reacted = new Map<string, Set<string>>()
  const voteOf = (emojis: Set<string> | undefined): number => Math.sign([...emojis ?? []].reduce((n, e) => n + valenceOf(e), 0))

  const client = robot.adapter && robot.adapter.client
  if (client && typeof client.on === 'function') {
    const onReaction = (sign: 1 | -1) => async (reaction: DiscordReaction, user: DiscordUser) => {
      if (user.bot) return
      const emoji = reaction.emoji.name
      if (!valenceOf(emoji)) return
      try {
        if (reaction.partial) await reaction.fetch()
      } catch {
        return
      }
      const message = reaction.message
      const botId = client.user?.id
      if (!message.author || message.author.id !== botId || !message.content) return
      if (!allowsRoom(robot, message.channelId, 'lines.scoring')) return
      const key = `${user.id}:${message.id}`
      const emojis = reacted.get(key) ?? new Set<string>()
      if (sign > 0 ? emojis.has(emoji) : !emojis.has(emoji)) return
      const before = voteOf(emojis)
      if (sign > 0) emojis.add(emoji)
      else emojis.delete(emoji)
      if (emojis.size) reacted.set(key, emojis)
      else reacted.delete(key)
      if (reacted.size > 5000) reacted.clear()
      const change = voteOf(emojis) - before
      if (change) for (const ref of linesIn(message.content)) scoreLine(ref, change)
    }
    client.on('messageReactionAdd', onReaction(1))
    client.on('messageReactionRemove', onReaction(-1))
  }

  robot.respond(/whimsy$/i, { id: 'whimsy.stats' }, async res => {
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

  robot.respond(/whimsy refill$/i, { id: 'whimsy.refill' }, async res => {
    if (!isOwner(res)) {
      await res.send(OWNER_ONLY)
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
