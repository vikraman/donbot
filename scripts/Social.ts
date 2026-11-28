// Description:
//   Sends whiteboard photos from a bound channel to the group's Mastodon and Bluesky accounts.
//   Nothing goes out until the poster or channel staff react 📣, and a hold lets them undo it.
//
// Commands:
//   hubot social here [mastodon] [bluesky] [hold <time>] [tag <#tags>] [enhance <off|mild|strong>] - Sends 📣'd photos from this channel (Manage Channels).
//   hubot social off - Stops sending from this channel and cancels anything queued (Manage Channels).
//   hubot social status - Shows the accounts and this channel's settings.
//   hubot social queue - Lists photos waiting to go out from this channel.
//   hubot social retract <message link> - Cancels or deletes a post (poster or Manage Channels).
//
// Notes:
//   Off until someone who can manage the server runs "hubot enable social server".
//   React 📣 on a message with 1-4 photos to queue it, ❌ (or removing your 📣) cancels it, 🗑️ deletes it once sent.
//   The caption is the message text, and edits count until it goes. Lines like "alt: …" or "alt 2: …" describe the photos.
//   Photos are resized and stripped of metadata (including location), and boards are cleaned up, cropped and straightened.
//   An "enhance:" line changes that for one message, e.g. "enhance: strong, color 100, nocrop" (see hubot enhance help).
//   The 📣 reply previews the processed photos with what changed; to re-preview after an edit, remove and re-add your 📣.
//
// Configuration:
//   MASTODON_URL, MASTODON_TOKEN - Mastodon server and an access token with write:media and write:statuses.
//   BLUESKY_HANDLE, BLUESKY_APP_PASSWORD - Bluesky account and app password. BLUESKY_SERVICE - PDS, default https://bsky.social.
//   SOCIAL_VISIBILITY - Mastodon visibility: public (default), unlisted or private.
//

import type { Robot, Response, DiscordReaction, DiscordUser } from 'hubot'

import { rawMessageOf } from './lib/discordMessage.ts'
import { formatDuration } from './lib/duration.ts'
import { defineFeature } from './lib/features.ts'
import { isOwner } from './lib/owner.ts'
import { required } from './lib/match.ts'
import { canManage, canManageMember, MANAGE_ONLY } from './lib/permissions.ts'
import { allowsRoom } from './lib/policy.ts'
import { reactionGuard } from './lib/reactionGuard.ts'
import { baseEmoji } from './lib/reactions.ts'
import { channelOf, postFiles } from './lib/rooms.ts'
import { MAX_ATTEMPTS, scheduler } from './lib/schedule.ts'
import type { Job } from './lib/schedule.ts'
import { HOUR_MS, MINUTE_MS, formatWhen } from './lib/time.ts'
import { defaultTz } from './lib/timezone.ts'
import { parseDuration } from './lib/when.ts'
import { describeOptions, labelOf as presetOf, resolveEnhance } from './lib/enhance/board.ts'
import type { EnhanceSpec } from './lib/enhance/board.ts'
import { imagesOf, MAX_PHOTOS, messageOf, processPhotos } from './lib/enhance/photos.ts'
import type { Attachment, Processed } from './lib/enhance/photos.ts'
import { ENHANCE_HELP, parseEnhance, parseEnhanceSpec } from './lib/enhance/settings.ts'
import { cleanText, defaultAlt, fitCaption, parseAlts, parseTags } from './lib/social/caption.ts'
import { configuredTargets } from './lib/social/index.ts'
import { LABELS, TARGET_IDS } from './lib/social/types.ts'
import type { Image, Posted, Target, TargetId } from './lib/social/types.ts'

defineFeature({ id: 'social', label: 'Social posting', level: 'professional', optIn: true, stores: 'bound channels, and which messages were posted where', help: ['hubot social'] })

const SEND = '📣'
const CANCEL = '❌'
const RETRACT = '🗑️'
const DONE = '✅'

const DEFAULT_HOLD_MS = 10 * MINUTE_MS
const MAX_HOLD_MS = 24 * HOUR_MS

interface Msg {
  id: string
  channelId: string
  guildId?: string | null
  content?: string
  createdTimestamp?: number
  partial?: boolean
  author?: { id: string, username?: string }
  attachments?: { values: () => Iterable<Attachment> }
  mentions?: { users?: Map<string, { username?: string, globalName?: string | null }> }
  channel?: { name?: string, parentId?: string | null, isThread?: () => boolean }
  fetch?: () => Promise<Msg>
  react?: (emoji: string) => Promise<unknown>
}

interface ChannelLike {
  messages?: { fetch: (id: string) => Promise<Msg> }
}

interface Binding {
  targets: TargetId[]
  holdMs: number
  tag: string
  enhance?: EnhanceSpec
  by: string
  at: number
}

type Status = 'queued' | 'posted' | 'cancelled' | 'failed' | 'retracted'

interface PostRecord {
  status: Status
  // message channel, bound channel
  channel: string
  bound: string
  guild: string | null
  message: string
  author: string
  by: string
  at: number
  sendAt: number
  targets: TargetId[]
  tag: string
  results: Partial<Record<TargetId, Posted>>
  error?: string
}

interface JobData {
  message: string
}

const bindingKey = (channel: string) => `social:channel:${channel}`
const postKey = (message: string) => `social:post:${message}`
const jobId = (message: string) => `msg-${message}`

const labelOf = (id: TargetId): string => LABELS[id]

const listOf = (items: string[]): string =>
  items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`

const messageLink = (rec: Pick<PostRecord, 'guild' | 'channel' | 'message'>): string =>
  `https://discord.com/channels/${rec.guild ?? '@me'}/${rec.channel}/${rec.message}`

// discord unknown message/channel
const isGone = (error: unknown): boolean => [10003, 10008].includes(Number((error as { code?: unknown } | null)?.code))

interface HereArgs {
  targets?: TargetId[]
  holdMs?: number
  tag?: string
  enhance?: EnhanceSpec
}

// social here args
export const parseHere = (args: string): HereArgs | string => {
  const marks = [...args.matchAll(/(?<!#)\b(hold|tags?|enhance)\b/gi)].map(m => ({ word: m[1]!.toLowerCase(), at: m.index }))
  const head = args.slice(0, marks[0]?.at ?? args.length)
  const out: HereArgs = {}
  let enhanceErrors: string[] = []
  marks.forEach((mark, i) => {
    const value = args.slice(mark.at + mark.word.length, marks[i + 1]?.at ?? args.length).trim()
    if (mark.word === 'hold') out.holdMs = value ? parseDuration(value, 'm') ?? (/^(none|no|off|0)$/i.test(value) ? 0 : -1) : -1
    else if (mark.word === 'enhance') {
      const parsed = parseEnhanceSpec(value || 'mild')
      out.enhance = parsed.spec
      enhanceErrors = parsed.errors
    } else out.tag = /^(none|off)$/i.test(value) ? '' : parseTags(value)
  })
  if (enhanceErrors.length) return `Enhance takes ${ENHANCE_HELP} (${enhanceErrors.join(', ')}).`
  if (out.holdMs !== undefined && (out.holdMs < 0 || out.holdMs > MAX_HOLD_MS)) return 'The hold should be a time up to a day, like `hold 10m` or `hold none`.'
  const words = head.split(/[\s,]+/).map(w => w.toLowerCase()).filter(w => w && !['and', 'to', 'on'].includes(w))
  const unknown = words.filter(w => !(TARGET_IDS as readonly string[]).includes(w))
  if (unknown.length) return `I can send to ${listOf([...TARGET_IDS])}, not ${unknown.join(', ')}.`
  if (words.length) out.targets = [...new Set(words as TargetId[])]
  return out
}

export default async (robot: Robot) => {
  const tz = defaultTz()

  const binding = (channel: string): Binding | undefined => robot.brain.get<Binding>(bindingKey(channel)) ?? undefined
  const getPost = (message: string): PostRecord | undefined => robot.brain.get<PostRecord>(postKey(message)) ?? undefined
  const savePost = (rec: PostRecord) => robot.brain.set(postKey(rec.message), rec)
  // re-read for concurrent cancel
  const updatePost = (message: string, change: (rec: PostRecord) => PostRecord) => {
    const rec = getPost(message)
    if (rec) savePost(change(rec))
  }

  // reply to photo
  const notify = async (room: string, text: string, replyTo?: string) => {
    try {
      await postFiles(robot, room, text, [], { feature: 'social', ...replyTo ? { replyTo } : {} })
    } catch (error) {
      robot.logger.warn(`social: couldn't post in ${room}: ${String(error)}`)
    }
  }

  // bound channel, threads use parent
  const boundFor = (msg: Msg): string | undefined => {
    if (binding(msg.channelId)) return msg.channelId
    const parent = msg.channel?.parentId
    return parent && binding(parent) ? parent : undefined
  }

  const fetchMessage = async (channelId: string, id: string): Promise<Msg | undefined> => {
    try {
      const channel = await channelOf<ChannelLike>(robot, channelId)
      if (!channel?.messages) return undefined
      return await channel.messages.fetch(id)
    } catch (error) {
      if (isGone(error)) return undefined
      throw error
    }
  }

  const nameOf = (msg: Msg) => (id: string): string | undefined => {
    const user = msg.mentions?.users?.get(id)
    return user ? user.globalName || user.username : robot.brain.userForId(id)?.name
  }

  // caption, alts, enhance options
  const partsOf = (msg: Msg, bound: string) => {
    const { body: withEnhance, alts } = parseAlts(msg.content ?? '')
    const { body, spec, errors } = parseEnhance(withEnhance)
    return { text: cleanText(body, nameOf(msg)), alts, enhance: resolveEnhance(binding(bound)?.enhance, spec), errors }
  }

  const dateOf = (ms: number) => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz }).format(ms)

  // alts
  const altsFor = (msg: Msg, done: Processed[], text: string, alts: (string | undefined)[]): { alt: string, given: boolean }[] =>
    done.map((p, i) => alts[i] ? { alt: alts[i], given: true } : {
      alt: defaultAlt({
        board: p.photo?.stats?.enhance?.board,
        channel: msg.channel?.name,
        date: msg.createdTimestamp ? dateOf(msg.createdTimestamp) : undefined,
        index: i, total: done.length, caption: text
      }),
      given: false
    })

  const stillQueued = (message: string) => getPost(message)?.status === 'queued'

  const sendOut = async (rec: PostRecord, msg: Msg, final: boolean): Promise<string[]> => {
    const available = configuredTargets()
    const pending = rec.targets.filter(t => !rec.results[t])
    const ready = pending.map(t => available[t]).filter((t): t is Target => Boolean(t))
    const errors = pending.filter(t => !available[t]).map(t => `${labelOf(t)} isn't set up any more`)
    if (!ready.length) return errors
    const { text, alts, enhance } = partsOf(msg, rec.bound)
    // reuses the preview
    const done = await processPhotos(msg, Math.min(...ready.map(t => t.maxBytes)), enhance, { cache: true })
    const failure = done.find(p => !p.photo)
    if (failure) throw new Error(failure.error)
    const described = altsFor(msg, done, text, alts)
    const images: Image[] = done.map((p, i) => ({ ...p.photo!, alt: described[i]!.alt }))
    for (const target of ready) {
      // cancelled while processing
      if (!stillQueued(rec.message)) break
      try {
        // per queueing
        const posted = await target.post(fitCaption(text, rec.tag, target.limit, target.count), images, `donbot-${rec.message}-${rec.at}`)
        rec.results[target.id] = posted
        updatePost(rec.message, r => ({ ...r, results: { ...r.results, [target.id]: posted } }))
      } catch (error) {
        robot.logger.warn(`social: ${target.id} failed for ${rec.message}: ${String(error)}`)
        errors.push(messageOf(error))
      }
    }
    if (errors.length && !final) throw new Error(errors.join('; '))
    return errors
  }

  const fire = async (job: Job<JobData>) => {
    const rec = getPost(job.data.message)
    if (!rec || rec.status !== 'queued') return
    const msg = await fetchMessage(rec.channel, rec.message)
    if (!msg || !imagesOf(msg).length) {
      const done = await cancel(rec, false)
      if (msg) await notify(rec.channel, `${SEND} No photos left. ${done.replace(`${SEND} `, '')}`, rec.message)
      return
    }
    const final = (job.attempts ?? 0) + 1 >= MAX_ATTEMPTS
    let errors: string[]
    try {
      errors = await sendOut(rec, msg, final)
    } catch (error) {
      if (!final) throw error
      errors = [messageOf(error)]
    }
    // cancelled mid-send
    if (!stillQueued(rec.message)) {
      if (Object.keys(rec.results).length) await retract(rec)
      updatePost(rec.message, r => ({ ...r, status: 'cancelled' }))
      return
    }
    const sent = Object.entries(rec.results) as [TargetId, Posted][]
    updatePost(rec.message, r => ({ ...r, status: sent.length ? 'posted' : 'failed', ...errors.length ? { error: errors.join('; ') } : {} }))
    const lines = sent.map(([t, p]) => `${labelOf(t)}: <${p.url}>`)
    if (sent.length) {
      try { await msg.react?.(DONE) } catch {}
    }
    const failed = errors.length ? `Failed: ${errors.join('; ')}` : ''
    await notify(rec.channel, [sent.length ? `${SEND} Posted:` : `${SEND} Not posted.`, ...lines, failed].filter(Boolean).join('\n'), rec.message)
  }

  const jobs = scheduler<JobData>(robot, 'social', fire)

  // deletes partial copies
  const cancel = async (rec: PostRecord, note = true): Promise<string> => {
    jobs.remove(jobId(rec.message))
    const live = getPost(rec.message) ?? rec
    let text = `${SEND} Cancelled.`
    if (Object.keys(live.results).length) {
      text = `${SEND} Cancelled. ${await retract(live)}`
      const after = getPost(rec.message) ?? live
      savePost({ ...after, status: Object.keys(after.results).length ? 'posted' : 'cancelled' })
    } else {
      savePost({ ...live, status: 'cancelled' })
    }
    if (note) await notify(rec.channel, text, rec.message)
    return text
  }

  const retract = async (rec: PostRecord): Promise<string> => {
    const available = configuredTargets()
    const removed: string[] = []
    const errors: string[] = []
    const results = { ...rec.results }
    for (const [id, posted] of Object.entries(rec.results) as [TargetId, Posted][]) {
      const target = available[id]
      try {
        if (!target) throw new Error(`${labelOf(id)} isn't set up any more`)
        await target.remove(posted.ref)
        delete results[id]
        removed.push(labelOf(id))
      } catch (error) {
        errors.push(messageOf(error))
      }
    }
    const left = Object.keys(results).length
    savePost({ ...rec, results, status: left ? 'posted' : 'retracted' })
    return [removed.length ? `${RETRACT} Deleted from ${listOf(removed)}.` : '', errors.length ? `Couldn't delete: ${errors.join('; ')}` : ''].filter(Boolean).join(' ')
  }

  const queue = async (msg: Msg, bound: string, by: string) => {
    const existing = getPost(msg.id)
    if (existing && (existing.status === 'queued' || existing.status === 'posted')) return
    const photos = imagesOf(msg)
    if (!photos.length) {
      await notify(msg.channelId, `${SEND} No photo here.`, msg.id)
      return
    }
    const rule = binding(bound)!
    const available = configuredTargets()
    const targets = rule.targets.filter(t => available[t])
    if (!targets.length) {
      await notify(msg.channelId, `${SEND} No accounts set up.`, msg.id)
      return
    }
    const now = Date.now()
    const sendAt = now + rule.holdMs
    const rec: PostRecord = {
      status: 'queued', channel: msg.channelId, bound, guild: msg.guildId ?? null, message: msg.id,
      author: msg.author?.id ?? '', by, at: now, sendAt, targets, tag: rule.tag, results: {}
    }
    savePost(rec)
    jobs.add({ id: jobId(msg.id), at: sendAt, tz, data: { message: msg.id } })
    const { text, alts, errors, enhance } = partsOf(msg, bound)
    const notes: string[] = []
    if (errors.length) notes.push(`Bad enhance line (${errors.join(', ')}), using channel settings.`)
    if (photos.length > MAX_PHOTOS) notes.push(`First ${MAX_PHOTOS} photos only.`)
    for (const target of targets.map(t => available[t]!)) {
      if (fitCaption(text, rec.tag, target.limit, target.count).endsWith('…')) notes.push(`Caption cut to ${target.label}'s ${target.limit}.`)
    }
    const when = rule.holdMs ? formatWhen(sendAt, tz, now) : 'in a moment'
    const head = [`${SEND} To ${listOf(targets.map(labelOf))} ${when}, ${CANCEL} to stop.`, ...notes].join(' ')
    // preview, cached for the send
    const done = await processPhotos(msg, Math.min(...targets.map(t => available[t]!.maxBytes)), enhance, { cache: true })
    const described = altsFor(msg, done, text, alts)
    const lines = done.map((p, i) => described[i]!.given || !p.photo ? p.line : `${p.line}\n  alt: ${described[i]!.alt}`)
    const files = done.flatMap((p, i) => p.photo ? [{ data: p.photo.data, name: `preview-${i + 1}.jpg` }] : [])
    await postFiles(robot, msg.channelId, [head, ...lines].join('\n'), files, { feature: 'social', replyTo: msg.id })
  }

  // one refusal per message
  const refusals = reactionGuard(0)

  const onReaction = async (reaction: DiscordReaction, user: DiscordUser, added: boolean) => {
    if (user.bot) return
    const emoji = baseEmoji(reaction.emoji.name)
    if (![SEND, CANCEL, RETRACT].map(baseEmoji).includes(emoji)) return
    let msg = reaction.message as unknown as Msg
    if (!binding(msg.channelId) && !msg.channel) return
    if (reaction.partial) {
      try {
        msg = (await reaction.fetch()).message
      } catch {
        return
      }
    }
    if (msg.partial && msg.fetch) {
      try {
        msg = await msg.fetch()
      } catch {
        return
      }
    }
    const bound = boundFor(msg)
    if (!bound || !allowsRoom(robot, msg.channelId, 'social')) return
    const rec = getPost(msg.id)

    if (!added) {
      // queuer took back 📣
      if (emoji === baseEmoji(SEND) && rec?.status === 'queued' && rec.by === user.id) await cancel(rec)
      return
    }
    // ❌ 🗑️ need a record
    if (emoji !== baseEmoji(SEND) && !rec) return
    const allowed = msg.author?.id === user.id || await canManageMember(msg as Parameters<typeof canManageMember>[0], user.id)
    if (!allowed) {
      if (emoji === baseEmoji(SEND) && refusals.first(msg.id, 'refused')) {
        await notify(msg.channelId, `${SEND} Poster or channel staff only.`, msg.id)
      }
      return
    }
    if (emoji === baseEmoji(SEND)) await queue(msg, bound, user.id)
    else if (emoji === baseEmoji(CANCEL) && rec?.status === 'queued') await cancel(rec)
    else if (emoji === baseEmoji(RETRACT) && rec?.status === 'posted') await notify(rec.channel, await retract(rec), rec.message)
    else if (emoji === baseEmoji(RETRACT) && rec?.status === 'queued') await cancel(rec)
  }

  const client = robot.adapter?.client
  if (client && typeof client.on === 'function') {
    for (const [event, added] of [['messageReactionAdd', true], ['messageReactionRemove', false]] as const) {
      client.on(event, (reaction: DiscordReaction, user: DiscordUser) => {
        onReaction(reaction, user, added).catch((error: unknown) => robot.logger.warn(`social: reaction failed: ${String(error)}`))
      })
    }
  }

  const queuedIn = (room: string): PostRecord[] =>
    jobs.list().map(j => getPost(j.data.message)).filter((r): r is PostRecord => r?.status === 'queued' && r.bound === room)

  const describe = (rule: Binding): string => {
    const hold = rule.holdMs ? `${formatDuration(rule.holdMs)} after the ${SEND}` : `right after the ${SEND}`
    const e = resolveEnhance(rule.enhance)
    const look = `enhance ${e.enhance ? presetOf(e) : 'off'} (${describeOptions(e)})`
    return `sends ${SEND}'d photos to ${listOf(rule.targets.map(labelOf))} ${hold}${rule.tag ? `, tagged ${rule.tag}` : ''}, ${look}`
  }

  robot.respond(/social here(?:\s+(.+))?$/i, { id: 'social.here' }, async (res: Response) => {
    // no dms
    if (!canManage(res, 'channel', { dms: false })) {
      const dm = (rawMessageOf(res) as { guildId?: string | null } | undefined)?.guildId === null
      await res.send(dm ? 'Social posting works in server channels, not DMs.' : MANAGE_ONLY.channel)
      return
    }
    const parsed = parseHere(res.match[1] ?? '')
    if (typeof parsed === 'string') {
      await res.send(parsed)
      return
    }
    const available = configuredTargets()
    const room = res.message.room
    const old = binding(room)
    const targets = parsed.targets ?? old?.targets ?? TARGET_IDS.filter(t => available[t])
    const missing = targets.filter(t => !available[t])
    if (!targets.length || missing.length) {
      await res.send(missing.length ? `${listOf(missing.map(labelOf))} isn't set up. Add its credentials to the bot's environment first.` : 'No social accounts are set up yet.')
      return
    }
    const rule: Binding = {
      targets,
      holdMs: parsed.holdMs ?? old?.holdMs ?? DEFAULT_HOLD_MS,
      tag: parsed.tag ?? old?.tag ?? '',
      enhance: parsed.enhance ?? old?.enhance,
      by: res.message.user.id,
      at: Date.now()
    }
    robot.brain.set(bindingKey(room), rule)
    await res.send(`${SEND} This channel ${describe(rule)}. The poster or channel staff react ${SEND} on a photo to send it.`)
  })

  robot.respond(/social (?:off|stop)$/i, { id: 'social.off' }, async (res: Response) => {
    if (!canManage(res, 'channel')) {
      await res.send(MANAGE_ONLY.channel)
      return
    }
    const room = res.message.room
    if (!binding(room)) {
      await res.send(`This channel isn't sending photos anywhere.`)
      return
    }
    const queued = queuedIn(room)
    for (const rec of queued) await cancel(rec, false)
    robot.brain.remove(bindingKey(room))
    await res.send(`${SEND} This channel won't send photos any more${queued.length ? `, and ${queued.length} queued ${queued.length === 1 ? 'photo was' : 'photos were'} cancelled` : ''}.`)
  })

  robot.respond(/social(?: status)?$/i, { id: 'social.status' }, async (res: Response) => {
    const available = configuredTargets()
    const accounts = TARGET_IDS.map(t => `${labelOf(t)}: ${available[t] ? 'set up' : 'not set up'}`).join(', ')
    const rule = binding(res.message.room)
    await res.send([
      `**Accounts** ${accounts}${available.mastodon && process.env.SOCIAL_VISIBILITY ? ` (Mastodon visibility ${process.env.SOCIAL_VISIBILITY})` : ''}`,
      `**This channel** ${rule ? describe(rule) : `isn't bound. \`${robot.name} social here\` binds it.`}`
    ].join('\n'))
  })

  robot.respond(/social queue$/i, { id: 'social.queue' }, async (res: Response) => {
    const room = res.message.room
    const queued = queuedIn(room)
    if (!queued.length) {
      await res.send('Nothing is waiting to go out from here.')
      return
    }
    await res.send(queued.map(r => `• ${messageLink(r)} ${formatWhen(r.sendAt, tz)} to ${listOf(r.targets.map(labelOf))}`).join('\n'))
  })

  robot.respond(/social (?:retract|cancel|delete|undo) (.+)$/i, { id: 'social.retract' }, async (res: Response) => {
    const id = /(\d{5,})\D*$/.exec(required(res.match, 1))?.[1]
    const rec = id ? getPost(id) : undefined
    if (!rec || !['queued', 'posted'].includes(rec.status)) {
      await res.send(`I haven't queued or posted that message. Use a message link, from "Copy Message Link".`)
      return
    }
    const who = res.message.user.id
    // staff in the post's channel
    const original = rec.author === who || rec.by === who || isOwner(res) ? undefined : await fetchMessage(rec.channel, rec.message).catch(() => undefined)
    const allowed = rec.author === who || rec.by === who || isOwner(res) || (original ? await canManageMember(original as Parameters<typeof canManageMember>[0], who) : false)
    if (!allowed) {
      await res.send(`Only the person who posted it or channel staff can do that.`)
      return
    }
    if (rec.status === 'queued') {
      await res.send(await cancel(rec, false))
      return
    }
    await res.send(await retract(rec))
  })
}
