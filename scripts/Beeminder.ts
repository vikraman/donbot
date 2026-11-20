// Description:
//   A Beeminder client: shows linked members' goals by color and posts alerts to subscribed channels.
//   Polls each member when something can change (a goal turning red, zeno alerts that halve their
//   gap as a deadline nears, a derail), at least every couple of hours. Read-only.
//
// Commands:
//   hubot bee link <token> - (DM only) Links your Beeminder account with your personal auth token from https://www.beeminder.com/api/v1/auth_token.json. Stored encrypted.
//   hubot bee unlink - Forgets your token, alerts and subscriptions.
//   hubot bee [goals] [red|orange|blue|green|gray] - Lists your goals, most urgent first. Secret goals only show in DMs.
//   hubot bee goals for <user> - Lists someone else's public goals.
//   hubot bee <goal> - Shows one of your goals.
//   hubot bee subscribe [goal ...] - Posts alerts for your goals here: turning red, deadline countdown, rescues and derails. Defaults to all public goals.
//   hubot bee unsubscribe [goal ...] - Stops some or all of your alerts here.
//   hubot bee subscriptions - Lists whose Beeminder alerts post here.
//
// Notes:
//   Also answers to "beeminder" in place of "bee".
//
// Configuration:
//   BEEMINDER_TOKEN_KEY - Key that encrypts stored tokens, 32 bytes as base64 (openssl rand -base64 32). Linking is off without it.
//   BEEMINDER_MAX_POLL_HOURS - Longest gap between polls of a subscribed member. Defaults to 2.
//   BEEMINDER_ZENO_START_HOURS - First countdown alert this long before a red goal derails, then half as long each time. Defaults to 8.
//   BEEMINDER_QUIET_HOURS - Hours in each member's Beeminder timezone when "went red" and derail alerts wait, e.g. 1-8 (the default) or off. Countdowns still go out.
//

import type { Robot, Response } from 'hubot'

import {
  beeminderClient, byUrgency, canSeal, COLOR_EMOJI, colorOf, COLORS, createdMs, DERAIL_CHECK_MS, DERAIL_COMMENT,
  DERAIL_WAIT_MS, dueZenoStep, goalUrl, isQuiet, loseMs, needText, nextPollAt, openToken, parseQuiet, quietEnd,
  sealToken, timeLeft, TOKEN_RE, touchedMs, ZENO_FLOOR_MS
} from './lib/beeminder.ts'
import type { Color, Goal } from './lib/beeminder.ts'
import { entriesWithPrefix } from './lib/brainScan.ts'
import { defineLines } from './lib/lines.ts'
import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { postToRoom } from './lib/rooms.ts'
import { scheduler } from './lib/schedule.ts'
import { canonicalTz, DAY_MS, HOUR_MS, MINUTE_MS } from './lib/time.ts'
import { defaultTz, tzNote } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { peopleFor } from './lib/spaces.ts'

defineFeature({ id: 'beeminder', label: 'Beeminder', level: 'professional', help: ['hubot bee'] })

const TOKEN_PREFIX = 'bee:token:'
const USER_PREFIX = 'bee:user:'
const TZ_PREFIX = 'bee:tz:'
const DM_PREFIX = 'bee:dm:'
const SNAP_PREFIX = 'bee:snap:'
const SUBS_KEY = 'bee:subs'
const RESERVED = new Set(['link', 'unlink', 'goals', 'subscribe', 'unsubscribe', 'subscriptions', 'help'])
const ERROR_RETRY_MS = 5 * MINUTE_MS
const TZ_REFRESH_MS = DAY_MS
const MAX_LISTED = 25

// all public goals ('*'), or these slugs; dm rooms may include secret goals
interface Sub {
  goals: '*' | string[]
  dm: boolean
}
type Subs = Record<string, Record<string, Sub>>

interface Snap {
  // when this was taken
  at?: number
  color: Color
  losedate: number
  safebuf: number
  zenoFor?: number
  zenoStep?: number
  // deadline passed, waiting for the derail datapoint
  derailFor?: number
}

interface PollJob {
  userId: string
}

const red = defineLines('beeminder.red', {
  fallback: [
    '{who}, *{goal}* is a beemergency: {need}.',
    '*{goal}* just went red, {who}. {need}.',
    'Red alert, {who}: *{goal}* needs {need}.',
    '{who}, *{goal}* is out of buffer. {need}.'
  ],
  rare: ['{who}, *{goal}* has turned the colour of a stop sign. {need}.']
})

const zeno = defineLines('beeminder.zeno', {
  fallback: [
    '{who}, *{goal}* derails in {left}: {need}.',
    '{left} left on *{goal}*, {who}. {need}.',
    'Tick tock, {who}: *{goal}* has {left} to go. {need}.',
    'Friendly buzz, {who}: *{goal}* derails in {left}.'
  ]
})

// last half hour
const zenoLast = defineLines('beeminder.zenoLast', {
  fallback: [
    '🚨 {who}, *{goal}* derails in {left}! {need}.',
    '🚨 {left}, {who}. *{goal}*. Now. {need}.',
    '🚨 Last call on *{goal}*, {who}: {left} left.'
  ],
  rare: ['🚨 {who}, the bees are getting restless. *{goal}* derails in {left}.']
})

const progress = defineLines('beeminder.progress', {
  fallback: [
    '{who} rescued *{goal}*: safe for {days}. 🎉',
    'Phew. *{goal}* is safe for {days}, {who}.',
    'Nice save, {who}! *{goal}* has {days} of buffer now.',
    '{who} bought *{goal}* {days} of breathing room.'
  ]
})

const derail = defineLines('beeminder.derail', {
  fallback: [
    '💥 {who} derailed on *{goal}*. Dust off and go again.',
    '💥 *{goal}* derailed, {who}. The bee stung. Next time.',
    '💥 {who}, *{goal}* went off the road. Recommitted, onwards.'
  ]
})

const days = (n: number): string => `${n} day${n === 1 ? '' : 's'}`

const envNumber = (name: string, fallback: number): number => {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

// discord dms have no guild; without the raw message (tests, shell) it's a channel
const isDm = (res: Response): boolean => {
  const raw = (res.message.user as { message?: { guildId?: string | null } }).message
  return Boolean(raw) && !raw?.guildId
}

const resolveUser = (robot: Robot, res: Response, who: string): string | undefined => {
  const mention = who.match(/^<@!?(\d+)>$/)
  if (mention) return mention[1]
  const users = peopleFor(robot, res, who.replace(/^@/, ''))
  return users.length === 1 ? users[0]!.id : undefined
}

export default async (robot: Robot) => {
  const maxMs = () => envNumber('BEEMINDER_MAX_POLL_HOURS', 2) * HOUR_MS
  const zenoStartMs = () => envNumber('BEEMINDER_ZENO_START_HOURS', 8) * HOUR_MS

  const usernameOf = (userId: string): string | undefined => {
    const name = robot.brain.get(`${USER_PREFIX}${userId}`)
    return typeof name === 'string' ? name : undefined
  }
  const beeTz = (userId: string): string => {
    const stored = robot.brain.get(`${TZ_PREFIX}${userId}`) as { tz?: string } | null
    return (stored?.tz && canonicalTz(stored.tz)) || defaultTz()
  }
  const clientFor = (userId: string) => {
    const token = openToken(robot.brain.get(`${TOKEN_PREFIX}${userId}`))
    return token ? beeminderClient(token) : undefined
  }
  const readSubs = (): Subs => (robot.brain.get(SUBS_KEY) as Subs | null) ?? {}
  const writeSubs = (subs: Subs) => robot.brain.set(SUBS_KEY, subs)
  const readSnaps = (userId: string): Record<string, Snap> => (robot.brain.get(`${SNAP_PREFIX}${userId}`) as Record<string, Snap> | null) ?? {}

  // rooms that get alerts for this goal
  const roomsFor = (userId: string, goal: Goal): string[] =>
    Object.entries(readSubs()).flatMap(([room, byUser]) => {
      const sub = byUser[userId]
      if (!sub || (goal.secret && !sub.dm)) return []
      return sub.goals === '*' || sub.goals.includes(goal.slug) ? [room] : []
    })

  const subscribedSomewhere = (userId: string): boolean => Object.values(readSubs()).some(byUser => byUser[userId])

  const polls = scheduler<PollJob>(robot, 'bee', job => poll(job.data.userId))
  const schedule = (userId: string, at: number) => polls.add({ id: `poll:${userId}`, at, tz: beeTz(userId), data: { userId } })

  const forget = (userId: string) => {
    for (const prefix of [TOKEN_PREFIX, USER_PREFIX, TZ_PREFIX, DM_PREFIX, SNAP_PREFIX]) robot.brain.remove(`${prefix}${userId}`)
    const subs = readSubs()
    for (const room of Object.keys(subs)) {
      delete subs[room]![userId]
      if (Object.keys(subs[room]!).length === 0) delete subs[room]
    }
    writeSubs(subs)
    polls.remove(`poll:${userId}`)
  }

  const refreshTz = async (userId: string) => {
    const stored = robot.brain.get(`${TZ_PREFIX}${userId}`) as { at?: number } | null
    if (stored?.at && Date.now() - stored.at < TZ_REFRESH_MS) return
    const me = await clientFor(userId)?.me()
    if (me?.body?.timezone) robot.brain.set(`${TZ_PREFIX}${userId}`, { tz: me.body.timezone, at: Date.now() })
  }

  // the derail datapoint lands hours after the deadline
  const derailConfirmed = async (userId: string, goal: Goal, deadline: number): Promise<boolean> => {
    if (goal.lost) return true
    const res = await clientFor(userId)?.datapoints(usernameOf(userId)!, goal.slug, 5)
    return (res?.body ?? []).some(d => DERAIL_COMMENT.test(d.comment ?? '') && createdMs(d) >= deadline - HOUR_MS)
  }

  const poll = async (userId: string) => {
    const client = clientFor(userId)
    const username = usernameOf(userId)
    if (!client || !username || !subscribedSomewhere(userId)) return
    const res = await client.goals(username)
    if (res.status === 401) {
      const dm = robot.brain.get(`${DM_PREFIX}${userId}`)
      forget(userId)
      if (typeof dm === 'string') await postToRoom(robot, dm, '🐝 Beeminder stopped accepting your token, so I unlinked you. DM me `bee link <token>` with a fresh one to start again.', 'beeminder')
      return
    }
    if (!res.body) {
      robot.logger.warn(`beeminder: goals for ${username} returned ${res.status}`)
      schedule(userId, Date.now() + ERROR_RETRY_MS)
      return
    }
    await refreshTz(userId)
    const tz = beeTz(userId)
    const now = Date.now()
    const old = readSnaps(userId)
    const snaps: Record<string, Snap> = {}
    const watched: Goal[] = []
    const who = mentionFor({ id: userId })
    const quiet = parseQuiet(process.env.BEEMINDER_QUIET_HOURS)
    const quietNow = isQuiet(now, tz, quiet)
    const wakeAt = quiet && quietNow ? quietEnd(now, tz, quiet) : undefined
    let held = false
    for (const goal of res.body) {
      const rooms = roomsFor(userId, goal)
      if (rooms.length === 0) continue
      watched.push(goal)
      const lose = loseMs(goal)
      const color = colorOf(goal)
      const step = color === 'red' ? dueZenoStep(now, lose, zenoStartMs(), ZENO_FLOOR_MS) : -1
      const snap: Snap = { at: now, color, losedate: lose, safebuf: goal.safebuf, zenoFor: lose, zenoStep: step }
      snaps[goal.slug] = snap
      const prev = old[goal.slug]
      // first sight just seeds
      if (!prev) continue
      const vars = { who, goal: goal.slug, need: needText(goal, tz, now), left: timeLeft(goal, now), days: days(goal.safebuf) }
      const opts = { tz }
      let text: string | undefined
      const deadline = prev.derailFor ?? (prev.losedate <= now ? prev.losedate : undefined)
      const touched = touchedMs(goal)
      // data that landed between the last look and the deadline
      const rescued = deadline !== undefined && lose > deadline && touched !== undefined && touched > (prev.at ?? 0) && touched <= deadline
      if (deadline !== undefined && !rescued) {
        const confirmed = await derailConfirmed(userId, goal, deadline)
        if (confirmed && !quietNow) {
          text = derail(vars, opts)
        } else if (confirmed) {
          // announce in the morning
          snap.derailFor = deadline
          held = true
          continue
        } else if (now - deadline < DERAIL_WAIT_MS) {
          snap.derailFor = deadline
          continue
        } else {
          continue
        }
      } else if (color === 'red' && prev.color !== 'red') {
        // overnight, unless the countdown has started
        if (step < 0 && wakeAt !== undefined && lose > wakeAt) {
          snap.color = prev.color
          held = true
        } else {
          text = red(vars, opts)
        }
      } else if ((prev.color === 'red' || prev.color === 'orange') && goal.safebuf > prev.safebuf) {
        text = progress(vars, opts)
      } else if (step >= 0 && (prev.zenoFor !== lose || step > (prev.zenoStep ?? -1))) {
        text = (lose - now <= 30 * MINUTE_MS ? zenoLast : zeno)(vars, opts)
      }
      if (text) for (const room of rooms) await postToRoom(robot, room, `🐝 ${text}`, 'beeminder')
    }
    robot.brain.set(`${SNAP_PREFIX}${userId}`, snaps)
    const next = nextPollAt(watched, now, tz, { maxMs: maxMs(), zenoStartMs: zenoStartMs() })
    const pending = Object.values(snaps).some(s => s.derailFor !== undefined)
    const soon = Math.min(next, pending ? now + DERAIL_CHECK_MS : Infinity, held && wakeAt !== undefined ? wakeAt : Infinity)
    schedule(userId, soon)
  }

  const goalLine = (goal: Goal, tz: string): string =>
    `${COLOR_EMOJI[colorOf(goal)]} **${goal.slug}**: ${needText(goal, tz)}`

  const listGoals = (goals: Goal[], tz: string): string => {
    const shown = goals.slice(0, MAX_LISTED).map(g => goalLine(g, tz))
    const more = goals.length > MAX_LISTED ? `\n…and ${goals.length - MAX_LISTED} more` : ''
    return `${shown.join('\n')}${more}`
  }

  // live goals, most urgent first
  const fetchGoals = async (res: Response, userId: string): Promise<Goal[] | undefined> => {
    const client = clientFor(userId)
    const username = usernameOf(userId)
    if (!client || !username) {
      await res.send(userId === res.message.user.id
        ? '🐝 You haven\'t linked Beeminder yet. DM me `bee link <token>` with your token from https://www.beeminder.com/api/v1/auth_token.json.'
        : `🐝 ${mentionFor({ id: userId })} hasn't linked Beeminder.`)
      return undefined
    }
    const reply = await client.goals(username)
    if (reply.status === 401) {
      await res.send('🐝 Beeminder rejected the stored token. Relink with `bee link <token>` in a DM.')
      return undefined
    }
    if (!reply.body) {
      await res.send(`🐝 Beeminder didn't answer (HTTP ${reply.status}). Try again in a bit.`)
      return undefined
    }
    return reply.body.filter(g => !g.won).sort(byUrgency)
  }

  const link = async (res: Response, token: string) => {
    if (!isDm(res)) {
      const raw = (res.message.user as { message?: { delete?: () => Promise<unknown> } }).message
      try {
        await raw?.delete?.()
      } catch {}
      await res.send('🐝 Never post your Beeminder token in a channel! I tried to delete that message, but treat the token as leaked: reset it in your Beeminder account settings, then DM me `bee link <new token>`.')
      return
    }
    if (!canSeal()) {
      await res.send('🐝 Beeminder linking is off: my owner hasn\'t set BEEMINDER_TOKEN_KEY.')
      return
    }
    if (!TOKEN_RE.test(token)) {
      await res.send('🐝 That doesn\'t look like a Beeminder auth token. Get yours at https://www.beeminder.com/api/v1/auth_token.json.')
      return
    }
    const me = await beeminderClient(token).me()
    if (!me.body?.username) {
      await res.send(me.status === 401 ? '🐝 Beeminder didn\'t accept that token.' : `🐝 Couldn't reach Beeminder (HTTP ${me.status}). Try again in a bit.`)
      return
    }
    const userId = res.message.user.id
    // one discord account per beeminder account
    const holder = entriesWithPrefix<string>(robot, USER_PREFIX, (v): v is string => typeof v === 'string')
      .find(([id, name]) => id !== userId && name.toLowerCase() === me.body!.username.toLowerCase())?.[0]
    if (holder) forget(holder)
    robot.brain.set(`${TOKEN_PREFIX}${userId}`, sealToken(token))
    robot.brain.set(`${USER_PREFIX}${userId}`, me.body.username)
    robot.brain.set(`${DM_PREFIX}${userId}`, res.message.room)
    if (me.body.timezone) robot.brain.set(`${TZ_PREFIX}${userId}`, { tz: me.body.timezone, at: Date.now() })
    await res.send(`🐝 Linked as **${me.body.username}**. Try \`bee goals\`, or \`bee subscribe\` in a channel for alerts there.`)
  }

  const showGoals = async (res: Response, userId: string, filter: Color | undefined, publicOnly: boolean) => {
    const goals = await fetchGoals(res, userId)
    if (!goals) return
    const tz = beeTz(userId)
    const shown = goals.filter(g => (!publicOnly || !g.secret) && (!filter || colorOf(g) === filter))
    const whose = userId === res.message.user.id ? 'Your' : `**${usernameOf(userId)}**'s`
    if (shown.length === 0) {
      await res.send(filter ? `🐝 No ${filter} goals. ${filter === 'red' ? '🎉' : ''}`.trim() : '🐝 No goals to show.')
      return
    }
    await res.send(`🐝 ${whose} ${filter ? `${filter} ` : ''}goals${tzNote(tz)}:\n${listGoals(shown, tz)}`)
  }

  const showGoal = async (res: Response, slug: string) => {
    const userId = res.message.user.id
    const goals = await fetchGoals(res, userId)
    if (!goals) return
    const goal = goals.find(g => g.slug.toLowerCase() === slug.toLowerCase())
    if (!goal || (goal.secret && !isDm(res))) {
      await res.send(`🐝 No goal called ${slug}${goal ? ' you can show here (it\'s secret)' : ''}. \`bee goals\` lists yours.`)
      return
    }
    const tz = beeTz(userId)
    const rate = goal.rate != null && goal.runits ? ` · rate ${Number(goal.rate.toFixed(2))}${goal.gunits ? ` ${goal.gunits}` : ''}/${goal.runits}` : ''
    const title = goal.title && goal.title !== goal.slug ? ` (${goal.title})` : ''
    await res.send([
      `🐝 ${COLOR_EMOJI[colorOf(goal)]} **${goal.slug}**${title}`,
      `${needText(goal, tz)}${tzNote(tz)}, ${timeLeft(goal)} left · ${days(goal.safebuf)} safe${rate}`,
      `<${goalUrl(usernameOf(userId)!, goal.slug)}>`
    ].join('\n'))
  }

  const subscribe = async (res: Response, slugs: string[]) => {
    const userId = res.message.user.id
    const goals = await fetchGoals(res, userId)
    if (!goals) return
    const dm = isDm(res)
    const room = res.message.room
    const visible = goals.filter(g => dm || !g.secret)
    const missing = slugs.filter(s => !visible.some(g => g.slug.toLowerCase() === s.toLowerCase()))
    if (missing.length > 0) {
      await res.send(`🐝 I can't find ${missing.join(', ')} among your ${dm ? '' : 'public '}goals.`)
      return
    }
    const subs = readSubs()
    const byUser = subs[room] ?? {}
    const prev = byUser[userId]
    const wanted = slugs.map(s => visible.find(g => g.slug.toLowerCase() === s.toLowerCase())!.slug)
    const merged: Sub['goals'] = slugs.length === 0 || prev?.goals === '*'
      ? '*'
      : [...new Set([...(prev?.goals ?? []), ...wanted])]
    byUser[userId] = { goals: merged, dm }
    subs[room] = byUser
    writeSubs(subs)
    schedule(userId, Date.now())
    const what = merged === '*' ? `all your ${dm ? '' : 'public '}goals` : merged.map(s => `*${s}*`).join(', ')
    await res.send(`🐝 Alerts for ${what} will buzz here: turning red, the countdown to a deadline, rescues and derails.`)
  }

  const unsubscribe = async (res: Response, slugs: string[]) => {
    const userId = res.message.user.id
    const room = res.message.room
    const subs = readSubs()
    const sub = subs[room]?.[userId]
    if (!sub) {
      await res.send('🐝 You have no Beeminder alerts here.')
      return
    }
    if (slugs.length > 0 && sub.goals === '*') {
      await res.send('🐝 You follow all your goals here. `bee unsubscribe` stops them all, then `bee subscribe <goal …>` picks some.')
      return
    }
    const left = slugs.length === 0 ? [] : (sub.goals as string[]).filter(s => !slugs.some(x => x.toLowerCase() === s.toLowerCase()))
    if (left.length === 0) delete subs[room]![userId]
    else subs[room]![userId] = { ...sub, goals: left }
    if (Object.keys(subs[room]!).length === 0) delete subs[room]
    writeSubs(subs)
    if (!subscribedSomewhere(userId)) polls.remove(`poll:${userId}`)
    await res.send(left.length === 0 ? '🐝 No more Beeminder alerts for you here.' : `🐝 Still following ${left.map(s => `*${s}*`).join(', ')} here.`)
  }

  const subscriptions = async (res: Response) => {
    const byUser = readSubs()[res.message.room] ?? {}
    const lines = Object.entries(byUser).map(([id, sub]) =>
      `${mentionFor({ id })} (${usernameOf(id) ?? '?'}): ${sub.goals === '*' ? 'all goals' : sub.goals.map(s => `*${s}*`).join(', ')}`)
    await res.send(lines.length === 0 ? '🐝 No Beeminder alerts post here. `bee subscribe` adds yours.' : `🐝 Beeminder alerts here:\n${lines.join('\n')}`)
  }

  robot.respond(/(?:beeminder|bee)\b[ \t]*(.*)$/i, { id: 'beeminder.command' }, async res => {
    const args = required(res.match, 1).trim()
    const [cmd = '', ...rest] = args.split(/\s+/).filter(Boolean)
    const word = cmd.toLowerCase()
    const color = (COLORS as readonly string[]).includes(word) ? word as Color : undefined
    if (word === 'link') {
      await link(res, rest[0] ?? '')
    } else if (word === 'unlink') {
      const had = usernameOf(res.message.user.id)
      forget(res.message.user.id)
      await res.send(had ? `🐝 Unlinked ${had}. Your token, alerts and subscriptions are gone.` : '🐝 No Beeminder account was linked.')
    } else if (word === 'goals' && rest[0]?.toLowerCase() === 'for' && rest.length > 1) {
      const target = resolveUser(robot, res, rest.slice(1).join(' '))
      if (!target) {
        await res.send(`🐝 I don't know who ${rest.slice(1).join(' ')} is.`)
        return
      }
      await showGoals(res, target, undefined, target !== res.message.user.id || !isDm(res))
    } else if (word === '' || word === 'goals' || color) {
      const filter = color ?? ((COLORS as readonly string[]).includes(rest[0]?.toLowerCase() ?? '') ? rest[0]!.toLowerCase() as Color : undefined)
      await showGoals(res, res.message.user.id, filter, !isDm(res))
    } else if (word === 'subscribe') {
      await subscribe(res, rest)
    } else if (word === 'unsubscribe') {
      await unsubscribe(res, rest)
    } else if (word === 'subscriptions') {
      await subscriptions(res)
    } else if (rest.length === 0 && /^[\w-]+$/.test(cmd) && !RESERVED.has(word)) {
      await showGoal(res, cmd)
    } else {
      await res.send('🐝 Try `bee goals`, `bee <goal>`, `bee subscribe` or `bee link <token>` (in a DM).')
    }
  })
}
