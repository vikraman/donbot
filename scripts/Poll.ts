// Description:
//   Runs reaction polls: yes/no or up to 10 options, optionally closing on a timer. Discord only.
//
// Commands:
//   hubot poll <question> - Posts a 👍/👎 poll for <question>.
//   hubot poll <question> | <option> | <option> ... - Posts a poll with up to 10 numbered options.
//   hubot poll <duration>: <question> [| <option> ...] - Same, closing after <duration> (e.g. 30m, 2h, 1d) with the results.
//   hubot poll results - Shows the tally for the latest poll in this room.
//   hubot poll close - Closes the latest poll now and posts the results (poll creator or owner).
//

import type { Robot, Response, DiscordChannel, DiscordMessage } from 'hubot'

import { rawMessageOf } from './lib/discordMessage.ts'
import { formatDuration } from './lib/duration.ts'
import { required } from './lib/match.ts'
import { scheduler } from './lib/schedule.ts'
import { DAY_MS, unitMs } from './lib/time.ts'

interface PollState {
  question: string
  // empty for yes/no
  options: string[]
  messageId: string
  creatorId: string
  closesAt?: number
  jobId?: string
  closed?: boolean
}

interface CloseJob {
  room: string
  messageId: string
}

const UP = '👍'
const DOWN = '👎'
const NUMBERS = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'] as const
export const MAX_DURATION_MS = 30 * DAY_MS

const pollKey = (room: string): string => `poll:${room}`

const emojisFor = (poll: PollState): string[] => poll.options.length ? NUMBERS.slice(0, poll.options.length) : [UP, DOWN]

const labelsFor = (poll: PollState): string[] => poll.options.length ? poll.options : ['yes', 'no']

// "30m", "2h", "1d"
const parseDuration = (text: string): number | undefined => {
  const m = text.trim().match(/^(\d+)\s*([a-z]+)$/i)
  const size = m && unitMs(m[2]!)
  return m && size ? Number(m[1]) * size : undefined
}

const countVotes = async (message: DiscordMessage, emoji: string): Promise<number> => {
  const reaction = message.reactions.cache.get(emoji)
  if (!reaction) return 0
  if (reaction.partial) await reaction.fetch()
  // minus the bot's own reaction
  return Math.max(reaction.count - 1, 0)
}

const tally = async (message: DiscordMessage, poll: PollState): Promise<number[]> =>
  Promise.all(emojisFor(poll).map(emoji => countVotes(message, emoji)))

const formatTally = (poll: PollState, counts: number[]): string => {
  if (!poll.options.length) return `"${poll.question}" — ${UP} ${counts[0] ?? 0} / ${DOWN} ${counts[1] ?? 0}`
  const lines = poll.options.map((option, i) => `${NUMBERS[i]} ${option} — ${counts[i] ?? 0}`)
  return [`"${poll.question}"`, ...lines].join('\n')
}

const formatWinner = (poll: PollState, counts: number[]): string => {
  const best = Math.max(0, ...counts)
  if (best === 0) return 'No votes.'
  const labels = labelsFor(poll)
  const winners = labels.filter((_, i) => counts[i] === best)
  const votes = `${best} ${best === 1 ? 'vote' : 'votes'}`
  return winners.length === 1 ? `Winner: ${winners[0]} (${votes}).` : `Tie between ${winners.join(' and ')} (${votes} each).`
}

export default async (robot: Robot) => {
  // room is the discord channel id
  const channelFor = async (room: string, res?: Response): Promise<DiscordChannel | undefined> => {
    const raw = res && rawMessageOf(res)
    if (raw && raw.channel) return raw.channel
    const channels = robot.adapter.client?.channels
    const cached = channels?.cache?.get(room)
    if (cached && cached.messages) return cached as DiscordChannel
    try {
      return await channels?.fetch?.(room) ?? undefined
    } catch {
      return undefined
    }
  }

  const close = async (room: string, poll: PollState, channel?: DiscordChannel) => {
    robot.brain.set(pollKey(room), { ...poll, closed: true, jobId: undefined })
    const ch = channel ?? await channelFor(room)
    if (!ch) {
      robot.logger.warn(`poll: can't reach channel ${room} to close "${poll.question}"`)
      return
    }
    const message = await ch.messages.fetch(poll.messageId)
    const counts = await tally(message, poll)
    await robot.messageRoom(room, `📊 Poll closed: ${formatTally(poll, counts)}\n${formatWinner(poll, counts)}`)
  }

  const closer = scheduler<CloseJob>(robot, 'poll', async job => {
    const poll = robot.brain.get<PollState>(pollKey(job.data.room))
    // replaced by a newer poll, or closed early
    if (!poll || poll.messageId !== job.data.messageId || poll.closed) return
    await close(job.data.room, poll)
  })

  robot.respond(/poll results$/i, async res => {
    const room = res.message.room
    const poll = robot.brain.get<PollState>(pollKey(room))
    if (!poll) {
      await res.send('No poll has been run in this room yet.')
      return
    }

    const channel = await channelFor(room, res)
    if (!channel) {
      await res.send("Can't look up poll results outside Discord.")
      return
    }

    const message = await channel.messages.fetch(poll.messageId)
    const counts = await tally(message, poll)
    const status = poll.closed ? 'closed' : poll.closesAt ? `closes in ${formatDuration(poll.closesAt - Date.now(), { round: Math.ceil })}` : 'open'
    await res.send(`${formatTally(poll, counts)}\n(${status})`)
  })

  robot.respond(/poll close$/i, async res => {
    const room = res.message.room
    const poll = robot.brain.get<PollState>(pollKey(room))
    if (!poll || poll.closed) {
      await res.send('There is no open poll in this room.')
      return
    }
    const user = res.message.user.id
    if (user !== poll.creatorId && user !== process.env.OWNER_USER_ID) {
      await res.send('Only whoever started the poll can close it.')
      return
    }
    if (poll.jobId) closer.remove(poll.jobId)
    const channel = await channelFor(room, res)
    if (!channel) {
      await res.send("Can't close polls outside Discord.")
      return
    }
    await close(room, poll, channel)
  })

  robot.respond(/poll (?!(?:results|close)$)(.+)$/i, async res => {
    const room = res.message.room
    let text = required(res.match, 1).trim()

    let durationMs: number | undefined
    const prefix = text.match(/^(\d+\s*[a-z]+):\s*(.+)$/i)
    if (prefix) {
      durationMs = parseDuration(required(prefix, 1))
      if (durationMs === undefined) {
        await res.send(`I don't understand the duration "${prefix[1]}". Try 30m, 2h or 1d.`)
        return
      }
      if (durationMs > MAX_DURATION_MS) {
        await res.send('Polls can run for at most 30 days.')
        return
      }
      text = required(prefix, 2).trim()
    }

    const [question = '', ...options] = text.split('|').map(s => s.trim())
    if (!question || options.some(o => !o)) {
      await res.send('Usage: poll <question> | <option> | <option> ...')
      return
    }
    if (options.length === 1) {
      await res.send('A poll needs at least two options.')
      return
    }
    if (options.length > NUMBERS.length) {
      await res.send(`Polls can have at most ${NUMBERS.length} options.`)
      return
    }

    const channel = await channelFor(room, res)
    if (!channel || typeof channel.send !== 'function') {
      await res.send('Polls only work in Discord channels, sorry.')
      return
    }

    const previous = robot.brain.get<PollState>(pollKey(room))
    if (previous?.jobId) closer.remove(previous.jobId)

    const poll: PollState = { question, options, messageId: '', creatorId: res.message.user.id }
    const lines = options.map((o, i) => `${NUMBERS[i]} ${o}`)
    const sent = await channel.send([`📊 ${question}`, ...lines].join('\n'))
    for (const emoji of emojisFor(poll)) await sent.react(emoji)
    poll.messageId = sent.id

    if (durationMs !== undefined) {
      poll.closesAt = Date.now() + durationMs
      poll.jobId = closer.add({ at: poll.closesAt, tz: 'UTC', data: { room, messageId: sent.id } }).id
    }
    robot.brain.set(pollKey(room), poll)
    const closing = durationMs !== undefined ? ` It closes in ${formatDuration(durationMs)}.` : ''
    await res.send(`Poll posted! Vote with the reactions above.${closing}`)
  })
}
