// Description:
//   Tracks message and reaction-feedback references per room (no message text stored,
//   only IDs), and lets you query them. Discord only for reactions/fetching.
//
// Commands:
//   hubot top message - Shows the most upvoted message in this room, all-time.
//   hubot top message day|week|month|year - Same, scoped to a time window.
//   hubot top message last week|last month|last year - Same, scoped to the previous window.
//   hubot most downvoted message - Shows the most downvoted message in this room.
//   hubot top 10 messages - Lists the top 10 messages by net score.
//   hubot last message from <user> - Shows the last message a user sent in this room.
//   hubot most active user - Shows who has sent the most messages in this room.
//   hubot least active user - Shows who has sent the fewest messages in this room.
//   hubot most|least active user day|week|month|year - Same, scoped to a time window.
//   hubot top 10 active users - Lists the 10 most active users by message count.
//

import { mentionFor } from './lib/mention.mjs'

const HISTORY_KEY_PREFIX = 'history:'
const HISTORY_KEY = room => `${HISTORY_KEY_PREFIX}${room}`

const REACTION_VALENCE = {
  '👍': 1, '❤️': 1, '🎉': 1, '🥳': 1, '😍': 1, '👏': 1, '💯': 1, '🔥': 1, '🙌': 1, '✨': 1,
  '👎': -1, '😢': -1, '😞': -1, '😡': -1, '😠': -1, '💔': -1, '😕': -1, '🤦': -1
}

const DAY_MS = 24 * 60 * 60 * 1000
const WINDOWS = {
  today: DAY_MS,
  day: DAY_MS,
  'this week': 7 * DAY_MS,
  week: 7 * DAY_MS,
  'last week': 7 * DAY_MS,
  'this month': 30 * DAY_MS,
  month: 30 * DAY_MS,
  'last month': 30 * DAY_MS,
  'this year': 365 * DAY_MS,
  year: 365 * DAY_MS,
  'last year': 365 * DAY_MS
}
// "last X" windows look back an extra period first, then span one period from there,
// rather than just being a bigger lookback from now
const LAST_PERIOD_OFFSET = {
  'last week': 7 * DAY_MS,
  'last month': 30 * DAY_MS,
  'last year': 365 * DAY_MS
}

const appendEntry = (robot, room, entry) => {
  const key = HISTORY_KEY(room)
  const entries = robot.brain.get(key) || []
  entries.push(entry)
  robot.brain.set(key, entries)
}

const logBotMessage = (robot, room, messageId) => {
  appendEntry(robot, room, { id: messageId, ts: Date.now(), kind: 'bot-message' })
}

const rawMessageOf = res => res.message.user && res.message.user.message

const netScores = entries => {
  const scores = new Map()
  for (const entry of entries) {
    if (entry.kind !== 'reaction-feedback') continue
    scores.set(entry.id, (scores.get(entry.id) || 0) + entry.valence)
  }
  return scores
}

const messageCounts = (entries, { since = null, until = null } = {}) => {
  const counts = new Map()
  for (const entry of entries) {
    if (entry.kind !== 'user-message') continue
    if (since != null && entry.ts < since) continue
    if (until != null && entry.ts >= until) continue
    counts.set(entry.authorId, (counts.get(entry.authorId) || 0) + 1)
  }
  return counts
}

const fetchText = async (channel, messageId) => {
  try {
    const message = await channel.messages.fetch({ message: messageId, cache: false })
    return message.content || '(no text)'
  } catch {
    return null
  }
}

const formatRelative = ts => {
  const minutes = Math.floor((Date.now() - ts) / 60000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const authorOf = (robot, entries, messageId) => {
  const entry = entries.find(e => e.id === messageId && e.kind === 'user-message')
  return entry ? entry.authorId : null
}

const describeMessage = async (robot, channel, entries, messageId, score) => {
  const text = await fetchText(channel, messageId)
  const authorId = authorOf(robot, entries, messageId)
  const mention = mentionFor({ id: authorId })
  if (text === null) {
    return `${mention} said something, but I can't find it anymore.`
  }
  return `${mention} said: "${text}" (${score >= 0 ? '+' : ''}${score})`
}

const topEntry = (scores, { sign = 1, since = null, until = null, entries = [] } = {}) => {
  const filtered = [...scores.entries()].filter(([id, score]) => {
    if (sign > 0 && score <= 0) return false
    if (sign < 0 && score >= 0) return false
    if (since != null || until != null) {
      const feedback = entries.filter(e => e.kind === 'reaction-feedback' && e.id === id)
      const inWindow = e => (since == null || e.ts >= since) && (until == null || e.ts < until)
      if (!feedback.some(inWindow)) return false
    }
    return true
  })
  filtered.sort((a, b) => sign > 0 ? b[1] - a[1] : a[1] - b[1])
  return filtered[0]
}

// resolves a period name to a { since, until } range; until is null (open-ended)
// except for "last X" periods, which are bounded to the single prior period
const resolveWindow = period => {
  if (!period) return { since: null, until: null }
  const span = WINDOWS[period]
  const offset = LAST_PERIOD_OFFSET[period]
  if (offset != null) return { since: Date.now() - 2 * offset, until: Date.now() - offset }
  return { since: Date.now() - span, until: null }
}

export default async (robot) => {
  robot.hear(/.*/, async res => {
    const user = res.message.user
    const raw = rawMessageOf(res)
    if (!user || user.id == null || !raw || !raw.id) return
    appendEntry(robot, res.message.room, { id: raw.id, ts: Date.now(), kind: 'user-message', authorId: user.id })
  })

  const client = robot.adapter && robot.adapter.client
  if (client && typeof client.on === 'function') {
    const recordFeedback = removed => async (reaction, user) => {
      if (user.bot) return
      const valence = REACTION_VALENCE[reaction.emoji.name]
      if (!valence) return
      if (reaction.partial) {
        try {
          await reaction.fetch()
        } catch {
          return
        }
      }
      const message = reaction.message
      appendEntry(robot, message.channelId, {
        id: message.id,
        ts: Date.now(),
        kind: 'reaction-feedback',
        valence: removed ? -valence : valence
      })
    }
    client.on('messageReactionAdd', recordFeedback(false))
    client.on('messageReactionRemove', recordFeedback(true))
  }

  robot.respond(/top message(?: (today|day|this week|week|last week|this month|month|last month|this year|year|last year))?$/i, async res => {
    const raw = rawMessageOf(res)
    const channel = raw && raw.channel
    if (!channel) {
      await res.send("Can't look up message history outside Discord.")
      return
    }
    const entries = robot.brain.get(HISTORY_KEY(res.message.room)) || []
    const period = res.match[1] && res.match[1].toLowerCase()
    const { since, until } = resolveWindow(period)
    const winner = topEntry(netScores(entries), { sign: 1, since, until, entries })
    if (!winner) {
      await res.send('No upvoted messages yet.')
      return
    }
    await res.send(await describeMessage(robot, channel, entries, winner[0], winner[1]))
  })

  robot.respond(/most downvoted message$/i, async res => {
    const raw = rawMessageOf(res)
    const channel = raw && raw.channel
    if (!channel) {
      await res.send("Can't look up message history outside Discord.")
      return
    }
    const entries = robot.brain.get(HISTORY_KEY(res.message.room)) || []
    const loser = topEntry(netScores(entries), { sign: -1, entries })
    if (!loser) {
      await res.send('No downvoted messages yet.')
      return
    }
    await res.send(await describeMessage(robot, channel, entries, loser[0], loser[1]))
  })

  robot.respond(/top (\d+) messages$/i, async res => {
    const raw = rawMessageOf(res)
    const channel = raw && raw.channel
    if (!channel) {
      await res.send("Can't look up message history outside Discord.")
      return
    }
    const entries = robot.brain.get(HISTORY_KEY(res.message.room)) || []
    const count = Math.min(Number(res.match[1]), 25)
    const ranked = [...netScores(entries).entries()].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1]).slice(0, count)
    if (ranked.length === 0) {
      await res.send('No upvoted messages yet.')
      return
    }
    const lines = await Promise.all(ranked.map(async ([id, score], i) => {
      const text = await fetchText(channel, id)
      const authorId = authorOf(robot, entries, id)
      const mention = mentionFor({ id: authorId })
      const preview = text === null ? "(can't find it anymore)" : `"${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`
      return `${i + 1}. ${mention} (+${score}): ${preview}`
    }))
    await res.send(lines.join('\n'))
  })

  robot.respond(/last message from @?([\w .-]+?)\??\s*$/i, async res => {
    const raw = rawMessageOf(res)
    const channel = raw && raw.channel
    if (!channel) {
      await res.send("Can't look up message history outside Discord.")
      return
    }
    const name = res.match[1].trim()
    const users = robot.brain.usersForFuzzyName(name)
    if (users.length === 0) {
      await res.send(`I don't know anything about ${name}.`)
      return
    }
    if (users.length > 1) {
      await res.send(`Be more specific, I know ${users.length} people named like that: ${users.map(u => u.name).join(', ')}`)
      return
    }

    const entries = robot.brain.get(HISTORY_KEY(res.message.room)) || []
    const userMessages = entries.filter(e => e.kind === 'user-message' && e.authorId === users[0].id).sort((a, b) => b.ts - a.ts)
    if (userMessages.length === 0) {
      await res.send(`I haven't seen ${name} say anything in this room.`)
      return
    }

    const latest = userMessages[0]
    const text = await fetchText(channel, latest.id)
    const mention = mentionFor({ id: latest.authorId })
    if (text === null) {
      await res.send(`${mention} said something ${formatRelative(latest.ts)}, but I can't find it anymore.`)
      return
    }
    await res.send(`${mention} said: "${text}" (${formatRelative(latest.ts)})`)
  })

  robot.respond(/(most|least) active user(?: (today|day|this week|week|last week|this month|month|last month|this year|year|last year))?$/i, async res => {
    const entries = robot.brain.get(HISTORY_KEY(res.message.room)) || []
    const period = res.match[2] && res.match[2].toLowerCase()
    const { since, until } = resolveWindow(period)
    const counts = [...messageCounts(entries, { since, until }).entries()]
    if (counts.length === 0) {
      await res.send('No messages tracked in this room yet.')
      return
    }

    const most = res.match[1].toLowerCase() === 'most'
    counts.sort((a, b) => most ? b[1] - a[1] : a[1] - b[1])
    const [authorId, count] = counts[0]
    const mention = mentionFor({ id: authorId })
    await res.send(`${mention} with ${count} ${count === 1 ? 'message' : 'messages'}.`)
  })

  robot.respond(/top (\d+) active users$/i, async res => {
    const entries = robot.brain.get(HISTORY_KEY(res.message.room)) || []
    const count = Math.min(Number(res.match[1]), 25)
    const ranked = [...messageCounts(entries).entries()].sort((a, b) => b[1] - a[1]).slice(0, count)
    if (ranked.length === 0) {
      await res.send('No messages tracked in this room yet.')
      return
    }

    const lines = ranked.map(([authorId, n], i) => `${i + 1}. ${mentionFor({ id: authorId })}: ${n}`)
    await res.send(lines.join('\n'))
  })
}

export { logBotMessage }
