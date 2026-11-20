// Description:
//   When someone sounds stuck or frustrated a few times in a row, now and then sends them a short
//   word of encouragement. Turned on and off with `pep talks on|off`, see Policy.ts.
//
// Commands:
//   hubot pep talk [<user>] - Sends a pep talk right now.
//
// Notes:
//   Each person gets at most one unprompted pep talk every 6 hours, and a channel at most one an hour.
//   Only a count of recent frustrated messages is kept, never their text.
//

import type { Robot } from 'hubot'

import { cooldown } from './lib/cooldown.ts'
import { defineLines } from './lib/lines.ts'
import type { LineOptions } from './lib/lines.ts'
import { mentionFor } from './lib/mention.ts'
import { addressesBot } from './lib/address.ts'
import { scoreTone } from './lib/sentiment.ts'
import { HOUR_MS, MINUTE_MS } from './lib/time.ts'
import { userTz } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { peopleFor } from './lib/spaces.ts'

defineFeature({ id: 'peptalk', label: 'Pep talks', level: 'casual', passive: true, stores: 'how many frustrated-sounding messages each person sent recently, in memory only', help: ['hubot pep talk'] })

// opt-in list from when pep talks were off by default
const LEGACY_ENABLED_KEY = 'peptalk:enabled'

export const STREAK_NEEDED = 3
export const STREAK_WINDOW_MS = 20 * MINUTE_MS
export const USER_COOLDOWN_MS = 6 * HOUR_MS
export const ROOM_COOLDOWN_MS = HOUR_MS

// sentiment misses most dev frustration
const FRUSTRATION = /\b(?:ugh+|argh+|stuck|blocked|broken|failing|fails|crash(?:es|ing)?|can'?t figure|no idea why|wtf|why (?:won'?t|doesn'?t|isn'?t)|hate this|giving up|frustrat\w*|so tired|exhausted|nothing works)\b/i

export const isFrustrated = (text: string): boolean => FRUSTRATION.test(text) || scoreTone(text).score <= -4

const pepTalk = defineLines('peptalk', {
  fallback: [
    '{who} you\'ve figured out harder things than this. Take a breather, it\'ll click.',
    '{who} rough patch, not a rough you. Rubber duck it with someone?',
    '{who} every bug you squash makes you better at this. You\'ve got it.',
    '{who} step away for five minutes. Fresh eyes fix more bugs than willpower.',
    '{who} being stuck is the part right before getting unstuck. 💪',
    '{who} want to talk it through here? Someone\'s probably hit this before.',
    '{who} hang in there. Write down what you\'ve ruled out, it helps.',
    '{who} it\'s fine to ask for help. Seriously. 🫶',
    '{who} the computer is wrong and you are right. Probably. Let\'s find out together.',
    '{who} go get a snack. Bugs fear people who have eaten.',
    '{who} explain it out loud to a houseplant. Works more often than it should.',
    '{who} you\'re not slow, this is just a weird one.',
    '{who} remember the last thing that felt impossible? Yeah. You did that.',
    '{who} it\'s a {weekday} {daypart} and you\'re fighting a gremlin. Be kind to yourself.',
    '{who} shrink the problem. Then shrink it again. It gets smaller, promise.',
    '{who} frustration means you care. Channel it, then go stretch.',
    '{who} take one deep breath. Okay, two. Now try the dumbest possible fix first.',
    '{who} future you is going to tell this story and laugh. Present you is allowed to grumble.'
  ],
  rare: [
    '{who} I have consulted the ancient scrolls. They say: "have you tried turning it off and on again?" Also: you\'ve got this.',
    '{who} by the power vested in me by absolutely nobody, I declare this bug doomed.',
    '{who} I sent a tiny robot army to cheer you on. They\'re very small. You might not see them. They\'re there.',
    '{who} a wizard is never stuck. They are merely gathering mana. Gather away.'
  ],
  ai: { about: 'a short, kind pep talk for a teammate who sounds stuck or frustrated with their work, starting with their name', slots: ['who'] }
})

export const pepTalkFor = (who: string, options: LineOptions = {}): string => pepTalk({ who }, options)

export default async (robot: Robot) => {
  const userCooldown = cooldown(USER_COOLDOWN_MS)
  const roomCooldown = cooldown(ROOM_COOLDOWN_MS)
  // user:room -> recent frustrated timestamps, in memory only
  const recent = new Map<string, number[]>()

  robot.brain.on('connected', () => { robot.brain.remove(LEGACY_ENABLED_KEY) })


  robot.respond(/pep ?talk (?:for |to )?@?(?!on$|off$|status$)(.+?)\s*$/i, { id: 'peptalk.for' }, async res => {
    const who = res.match[1]!
    const mention = who.match(/^<@!?(\d+)>$/)
    if (mention || who.toLowerCase() === 'me') {
      const target = mention ? { id: mention[1] } : res.message.user
      await res.send(pepTalkFor(mentionFor(target), { room: res.message.room, tz: userTz(robot, target.id) }))
      return
    }
    const users = peopleFor(robot, res, who)
    const sole = users.length === 1 ? users[0] : undefined
    await res.send(pepTalkFor(mentionFor(sole ?? { name: who }), { room: res.message.room, tz: userTz(robot, sole?.id) }))
  })

  robot.respond(/pep ?talk$/i, { id: 'peptalk.me' }, async res => {
    await res.send(pepTalkFor(mentionFor(res.message.user), { room: res.message.room, tz: userTz(robot, res.message.user.id) }))
  })

  robot.hear(/.*/, { id: 'peptalk.listen' }, async res => {
    const room = res.message.room
    const text = res.message.text || ''
    const user = res.message.user
    if (!user?.id || addressesBot(robot, text)) return
    if (!isFrustrated(text)) return

    const key = `${user.id}:${room}`
    const now = Date.now()
    const times = [...(recent.get(key) ?? []).filter(t => now - t < STREAK_WINDOW_MS), now]
    recent.set(key, times)
    // drop idle keys
    if (recent.size > 500) for (const [k, ts] of recent) if (now - ts.at(-1)! >= STREAK_WINDOW_MS) recent.delete(k)
    if (times.length < STREAK_NEEDED) return
    if (!userCooldown.ready(user.id) || !roomCooldown.ready(room)) return
    userCooldown.mark(user.id)
    roomCooldown.mark(room)
    recent.delete(key)
    await res.send(pepTalkFor(mentionFor(user), { room, tz: userTz(robot, user.id) }))
  })
}
