// Description:
//   Shows streaks: weekly standups, daily focus, daily wins and daily commits (with a linked GitHub account).
//
// Commands:
//   hubot streaks - Shows your streaks.
//   hubot streaks for <user> - Shows someone else's streaks.
//   hubot top streaks - Shows the longest running streak of each kind.
//

import type { Robot } from 'hubot'

import { entriesWithPrefix } from './lib/brainScan.ts'
import { githubLoginOf } from './lib/githubUsers.ts'
import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { getStreak, STREAK_KINDS, streakLabel, streakPeriod } from './lib/streak.ts'
import type { StreakKind } from './lib/streak.ts'

const ICONS: Record<StreakKind, string> = { standup: '📋', focus: '🎯', win: '🏆', commit: '🐙' }

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const describe = (robot: Robot, kind: StreakKind, userId: string): string | undefined => {
  const streak = getStreak(robot, kind, userId)
  if (!streak) return undefined
  const unit = streakPeriod(kind)
  const now = streak.current ? plural(streak.current, unit) : 'none right now'
  return `${ICONS[kind]} ${streakLabel(kind)}: ${now} (best ${plural(streak.best, unit)})`
}

export default async (robot: Robot) => {
  const show = async (userId: string, self: boolean, send: (text: string) => Promise<void>) => {
    const lines = STREAK_KINDS.map(kind => describe(robot, kind, userId)).filter((l): l is string => Boolean(l))
    if (lines.length === 0) {
      await send(self
        ? 'No streaks yet. Check in at standup, log a `win`, start a `focus` session, or link GitHub with `my github is <username>` to count commits.'
        : `${mentionFor({ id: userId })} has no streaks yet.`)
      return
    }
    const hint = self && !githubLoginOf(robot, userId) ? '\n(Link GitHub with `my github is <username>` to count commits too.)' : ''
    await send(`🔥 ${self ? 'Your' : `${mentionFor({ id: userId })}'s`} streaks:\n${lines.join('\n')}${hint}`)
  }

  robot.respond(/(?:my )?streaks?$/i, async res => {
    await show(res.message.user.id, true, text => res.send(text))
  })

  robot.respond(/streaks? for @?(.+?)\s*$/i, async res => {
    const who = required(res.match, 1)
    const mention = who.match(/^<@!?(\d+)>$/)
    const users = mention ? [{ id: mention[1]! }] : robot.brain.usersForFuzzyName(who)
    if (users.length !== 1) {
      await res.send(users.length ? `Be more specific, that matches ${users.length} people.` : `I don't know ${who}.`)
      return
    }
    await show(users[0]!.id, users[0]!.id === res.message.user.id, text => res.send(text))
  })

  robot.respond(/top streaks$/i, async res => {
    const lines: string[] = []
    for (const kind of STREAK_KINDS) {
      const best = entriesWithPrefix(robot, `streak:${kind}:`)
        .map(([userId]) => ({ userId, current: getStreak(robot, kind, userId)?.current ?? 0 }))
        .filter(s => s.current > 0)
        .sort((a, b) => b.current - a.current)
        .slice(0, 3)
      if (best.length) lines.push(`${ICONS[kind]} ${streakLabel(kind)}: ${best.map(s => `${mentionFor({ id: s.userId })} (${plural(s.current, streakPeriod(kind))})`).join(', ')}`)
    }
    await res.send(lines.length ? `🔥 Longest running streaks:\n${lines.join('\n')}` : 'Nobody has a streak going yet.')
  })
}
