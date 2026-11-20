// Description:
//   A log of small wins. Share one, cheer each other on, and look back at the week.
//
// Commands:
//   hubot win <what you did> - Logs a win.
//   hubot wins - Lists this channel's wins from the last 7 days.
//   hubot wins today|week|month - Same, for that window.
//   hubot wins for <user> - Lists someone's recent wins.
//
// Notes:
//   Only the text after "win" is stored, and only for 60 days.
//

import type { Robot, Response } from 'hubot'

import { formatAgo } from './lib/duration.ts'
import { eventsSince, logEvent } from './lib/eventLog.ts'
import type { LogEntry } from './lib/eventLog.ts'
import { defineLines } from './lib/lines.ts'
import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { recordStreak } from './lib/streak.ts'
import { DAY_MS, dayKey } from './lib/time.ts'
import { userTz } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { findPeople, spaceOfRes, storeOf } from './lib/spaces.ts'

defineFeature({ id: 'wins', label: 'Wins', level: 'professional', help: ['hubot win'] })

export interface WinEntry extends LogEntry {
  text: string
}

const MAX_LENGTH = 300
const MAX_LISTED = 15

const WINDOWS: Record<string, number> = { today: DAY_MS, day: DAY_MS, week: 7 * DAY_MS, month: 30 * DAY_MS }

const cheer = defineLines('wins.cheer', {
  fallback: [
    '🎉 Nice one, {who}!',
    '🙌 Look at {who} go.',
    '🏆 Logged. Well done, {who}.',
    '✨ That\'s a win, {who}.',
    '🥳 Love it, {who}!',
    '💪 Way to go, {who}.',
    '📈 Number go up. Nice, {who}.',
    '🌱 Small wins grow into big ones. Good stuff, {who}.',
    '🎯 Bullseye, {who}.',
    '🍰 This calls for cake, {who}. Metaphorical cake.',
    '🧱 Another brick in the wall of progress, {who}.',
    '🎶 Somebody cue the victory music for {who}.',
    '📝 Written into the Book of Wins, {who}.',
    '🌞 What a {daypart} for it, {who}.',
    '🦾 Crushed it, {who}.',
    '🪄 {who} made a thing happen. Magic.'
  ],
  rare: [
    '🏟️ The crowd goes wild! (The crowd is me. I am going wild.) Congrats, {who}.',
    '📜 Historians will one day write about this win, {who}. Footnotes, mostly, but still.',
    '🐉 {who} has slain a dragon. A small, bureaucratic dragon, but a dragon.',
    '🎰 Jackpot! {who} rolled a natural win.',
    '🛸 Aliens observing Earth have noted {who}\'s win. They are impressed.'
  ],
  flair: true,
  ai: { about: 'cheering for someone who just shared a small win at work', slots: ['who'] }
})

// third win and beyond in one day
const busyDay = defineLines('wins.busyDay', {
  professional: ['That\'s {today} wins today.', '{today} wins today. Great progress.'],
  fallback: [
    'That\'s {today} wins today. Save some for the rest of us.',
    '{today} wins today! Is this a speedrun?',
    'Win number {today} today. You\'re on fire. Not literally, I hope.',
    '{today} today already. Someone\'s having a {daypart}.'
  ]
})

export const WIN_MILESTONES = [10, 25, 50, 100, 250, 500] as const

const milestone = defineLines('wins.milestone', {
  professional: ['🎊 That\'s win number {total} for {who}. Milestone!', '🎊 {total} wins logged, {who}.'],
  fallback: [
    '🎊 That\'s win number {total} for {who}. Milestone unlocked!',
    '🎊 {total} wins logged, {who}. That\'s a whole trophy cabinet.',
    '🎊 Win {total}! {who}, you\'re a certified winner now. I printed a certificate. In my head.'
  ]
})

const winCountKey = (userId: string): string => `wins:count:${userId}`

const listWins = async (res: Response, wins: WinEntry[], empty: string) => {
  if (wins.length === 0) {
    await res.send(empty)
    return
  }
  const shown = wins.slice(-MAX_LISTED).reverse()
  const lines = shown.map(w => `• ${mentionFor({ id: w.userId })}: ${w.text} (${formatAgo(w.ts)})`)
  const more = wins.length > shown.length ? `\n…and ${wins.length - shown.length} more.` : ''
  await res.send(`${lines.join('\n')}${more}`)
}

export default async (robot: Robot) => {
  robot.respond(/win[:\s]+(.+)$/i, { id: 'wins.add' }, async res => {
    const text = required(res.match, 1).trim().slice(0, MAX_LENGTH)
    const userId = res.message.user.id
    const store = storeOf(robot, res)
    logEvent(robot, 'win', { room: res.message.room, space: store.space, userId, text })
    const streak = recordStreak(robot, store.space, 'win', userId)
    const tz = userTz(robot, userId)
    const opts = { room: res.message.room, tz }
    const who = mentionFor({ id: userId, name: res.message.user.name })
    const stored = store.get(winCountKey(userId))
    const total = (typeof stored === 'number' ? stored : 0) + 1
    store.set(winCountKey(userId), total)
    const today = eventsSince<WinEntry>(robot, 'win', Date.now() - DAY_MS, { space: store.space })
      .filter(w => w.userId === userId && dayKey(w.ts, tz) === dayKey(Date.now(), tz)).length
    const extra = (WIN_MILESTONES as readonly number[]).includes(total)
      ? milestone({ who, total }, opts)
      : today >= 3 ? busyDay({ who, today }, opts) : undefined
    await res.send([cheer({ who, win: text }, opts), extra, streak].filter(Boolean).join('\n'))
  })

  robot.respond(/wins(?: (today|day|week|month))?$/i, { id: 'wins.list' }, async res => {
    const period = (res.match[1] || 'week').toLowerCase()
    const wins = eventsSince<WinEntry>(robot, 'win', Date.now() - WINDOWS[period]!, res.message.room)
    await listWins(res, wins, `No wins logged here for that window yet. \`${robot.name} win <something>\` adds one.`)
  })

  robot.respond(/wins for @?(.+?)\s*$/i, { id: 'wins.for' }, async res => {
    const who = required(res.match, 1)
    const mention = who.match(/^<@!?(\d+)>$/)
    const space = spaceOfRes(robot, res)
    const users = mention ? [{ id: mention[1]!, name: who }] : findPeople(robot, space, who)
    const sole = users.length === 1 ? users[0] : undefined
    if (!sole) {
      await res.send(users.length === 0 ? `I don't know ${who}.` : `Be more specific, that matches ${users.map(u => u.name).join(', ')}.`)
      return
    }
    const wins = eventsSince<WinEntry>(robot, 'win', Date.now() - 30 * DAY_MS, { space }).filter(w => w.userId === sole.id)
    await listWins(res, wins, `${mentionFor(sole)} hasn't logged any wins in the last 30 days.`)
  })
}
