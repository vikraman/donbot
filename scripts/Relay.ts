// Description:
//   Relays individual messages between bridged Discord channels and Zulip topics. Nothing
//   crosses unless the sender starts the message with ">>". Zulip users can also DM the bot.
//
// Commands:
//   >> <message> - In a bridged channel, sends <message> to the linked Zulip topic.
//   hubot relay - Explains the relay and shows where this channel is bridged.
//   hubot relay status - (Owner only) Shows all bridges and the Zulip connection state.
//
// Configuration:
//   ZULIP_SITE - Zulip server URL, e.g. https://chat.example.org
//   ZULIP_BOT_EMAIL - Zulip bot account email.
//   ZULIP_API_KEY - Zulip bot API key.
//   RELAY_BRIDGES - discordChannelId=stream[/topic], comma-separated. No topic = general chat.
//   ZULIP_DM_CHANNEL - Discord channel id that Zulip DMs go to. Optional if only one bridge.
//   OWNER_USER_ID - Discord user ID allowed to run relay status.
//

import type { Robot, Response } from 'hubot'

import { rawMessageOf } from './lib/discordMessage.ts'
import { zulipClient } from './lib/zulip.ts'
import type { ZulipClient, ZulipEvent, ZulipMessage } from './lib/zulip.ts'

export interface Bridge {
  channel: string
  stream: string
  topic: string
}

const PREFIX = /^>>\s*/
const SUB_CACHE_MS = 10 * 60 * 1000
const DEDUP_LIMIT = 500
const ZWSP = '​'

export const parseBridges = (spec: string | undefined): Bridge[] =>
  (spec || '').split(',').map(s => s.trim()).filter(Boolean).flatMap(entry => {
    const eq = entry.indexOf('=')
    if (eq < 1) return []
    const channel = entry.slice(0, eq).trim()
    const target = entry.slice(eq + 1).trim()
    const slash = target.indexOf('/')
    const stream = (slash < 0 ? target : target.slice(0, slash)).trim()
    const topic = slash < 0 ? '' : target.slice(slash + 1).trim()
    return stream ? [{ channel, stream, topic }] : []
  })

const topicLabel = (topic: string): string => topic || 'general chat'

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

const plainName = (name: string): string => name.replace(/[*_`]/g, '').trim() || 'someone'

// zulip mentions become silent so nobody gets pinged from discord
export const silenceZulipMentions = (text: string): string => text.replace(/@(\*)/g, '@_$1')

// discord pings can't be triggered from zulip
export const neutraliseDiscordPings = (text: string): string =>
  text.replace(/@(everyone|here)/gi, `@${ZWSP}$1`).replace(/<@/g, `<${ZWSP}@`)

export const prettifyZulipMentions = (text: string): string =>
  text.replace(/@_?\*\*([^*|]+)(?:\|\d+)?\*\*/g, '@$1').replace(/@_?\*([^*]+)\*/g, '@$1')

const discordToZulip = (robot: Robot, res: Response, text: string): string => {
  const raw = rawMessageOf(res)
  const client = robot.adapter && robot.adapter.client
  const out = text
    .replace(/<@!?(\d+)>/g, (_, id: string) => {
      const user = raw?.mentions?.users?.get(id)
      const name = user?.globalName || user?.username || robot.brain.data.users[id]?.name
      return `@${name || 'someone'}`
    })
    .replace(/<@&\d+>/g, '@role')
    .replace(/<#(\d+)>/g, (_, id: string) => `#${client?.channels?.cache?.get(id)?.name || 'channel'}`)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
  const attachments = raw?.attachments ? [...raw.attachments.values()].map(a => a.url) : []
  return silenceZulipMentions([out, ...attachments].filter(Boolean).join('\n'))
}

export default async (robot: Robot) => {
  const site = process.env.ZULIP_SITE
  const email = process.env.ZULIP_BOT_EMAIL
  const apiKey = process.env.ZULIP_API_KEY
  const bridges = parseBridges(process.env.RELAY_BRIDGES)
  const configured = Boolean(site && email && apiKey && bridges.length > 0)

  const byChannel = new Map(bridges.map(b => [b.channel, b]))
  const dmEnv = process.env.ZULIP_DM_CHANNEL
  const dmBridge = dmEnv ? byChannel.get(dmEnv) : (bridges.length === 1 ? bridges[0] : undefined)

  const state: { connected: boolean, lastError?: string } = { connected: false }
  const relayed = new Set<string>()
  const streamIds = new Map<string, number>()
  const subCache = new Map<string, { ok: boolean, at: number }>()

  robot.respond(/relay$/i, async res => {
    if (!configured) {
      await res.send("The Zulip relay isn't set up.")
      return
    }
    const bridge = byChannel.get(String(res.message.user.room))
    if (!bridge) {
      await res.send("This channel isn't bridged to Zulip.")
      return
    }
    await res.send(`This channel is bridged to Zulip #${bridge.stream} > ${topicLabel(bridge.topic)}. Start a message with >> to send it there; only those messages cross over.`)
  })

  robot.respond(/relay status$/i, async res => {
    const ownerId = process.env.OWNER_USER_ID
    if (!ownerId || String(res.message.user.id) !== ownerId) {
      await res.send("That's need-to-know, and you don't need to know.")
      return
    }
    if (!configured) {
      await res.send("The Zulip relay isn't set up.")
      return
    }
    const lines = bridges.map(b => `<#${b.channel}> ↔ #${b.stream} > ${topicLabel(b.topic)}`)
    lines.push(`Zulip DMs → ${dmBridge ? `<#${dmBridge.channel}>` : 'off'}`)
    lines.push(`Zulip: ${state.connected ? 'connected' : 'disconnected'}${state.lastError ? ` (last error: ${state.lastError})` : ''}`)
    await res.send(lines.join('\n'))
  })

  if (!configured || !site || !email || !apiKey) return

  const zulip: ZulipClient = zulipClient({ site, email, apiKey })

  const fail = (err: unknown): string => {
    const msg = err instanceof Error ? err.message : String(err)
    state.lastError = msg
    return msg
  }

  robot.hear(/^>>\s*([\s\S]+)/, async res => {
    const bridge = byChannel.get(String(res.message.user.room))
    if (!bridge) return
    const raw = rawMessageOf(res)
    // edits are re-delivered by the adapter
    const id = raw?.id ?? (res.message.id !== undefined ? String(res.message.id) : undefined)
    if (id) {
      if (relayed.has(id)) return
      relayed.add(id)
      if (relayed.size > DEDUP_LIMIT) relayed.delete(relayed.values().next().value as string)
    }
    const text = discordToZulip(robot, res, (res.match[1] || '').trim())
    if (!text) return
    const name = plainName(raw?.member?.displayName || raw?.author?.username || res.message.user.name)
    try {
      await zulip.sendStream(bridge.stream, bridge.topic, `**${name}** (discord): ${text}`)
      await raw?.react('✅').catch(() => {})
    } catch (err) {
      fail(err)
      await raw?.react('❌').catch(() => {})
    }
  })

  const subscribed = async (userId: number, stream: string): Promise<boolean> => {
    let sid = streamIds.get(stream)
    if (sid === undefined) {
      sid = await zulip.streamId(stream)
      streamIds.set(stream, sid)
    }
    const key = `${userId}:${sid}`
    const cached = subCache.get(key)
    if (cached && Date.now() - cached.at < SUB_CACHE_MS) return cached.ok
    const ok = await zulip.isSubscribed(userId, sid)
    subCache.set(key, { ok, at: Date.now() })
    return ok
  }

  const toDiscord = (msg: ZulipMessage, text: string, via: string): string =>
    neutraliseDiscordPings(`**${plainName(msg.sender_full_name)}** (${via}): ${prettifyZulipMentions(text)}`)

  const handleDirect = async (msg: ZulipMessage) => {
    // group dms: the others never agreed to relay
    if (!Array.isArray(msg.display_recipient) || msg.display_recipient.length !== 2) return
    const text = msg.content.replace(PREFIX, '').trim()
    if (!text) return
    if (!dmBridge) {
      await zulip.sendDirect(msg.sender_id, "Relaying from DMs isn't set up here.")
      return
    }
    let ok: boolean
    try {
      ok = await subscribed(msg.sender_id, dmBridge.stream)
    } catch (err) {
      await zulip.sendDirect(msg.sender_id, `Couldn't check your access: ${fail(err)}`)
      return
    }
    if (!ok) {
      await zulip.sendDirect(msg.sender_id, `Sorry, you need to be subscribed to #**${dmBridge.stream}** to relay to Discord.`)
      return
    }
    try {
      await robot.messageRoom(dmBridge.channel, toDiscord(msg, text, 'zulip DM'))
      await zulip.react(msg.id, 'check')
    } catch (err) {
      const reason = fail(err)
      await zulip.react(msg.id, 'cross_mark').catch(() => {})
      await zulip.sendDirect(msg.sender_id, `Couldn't relay that: ${reason}`)
    }
  }

  const handleStream = async (msg: ZulipMessage) => {
    if (!PREFIX.test(msg.content)) return
    const stream = typeof msg.display_recipient === 'string' ? msg.display_recipient : ''
    const targets = bridges.filter(b => sameName(b.stream, stream) && sameName(b.topic, msg.subject))
    const text = msg.content.replace(PREFIX, '').trim()
    if (!text) return
    for (const bridge of targets) {
      try {
        await robot.messageRoom(bridge.channel, toDiscord(msg, text, 'zulip'))
      } catch (err) {
        fail(err)
      }
    }
  }

  const onEvent = async (event: ZulipEvent) => {
    const msg = event.type === 'message' ? event.message : undefined
    if (!msg || sameName(msg.sender_email, email)) return
    if (msg.type === 'private') await handleDirect(msg)
    else await handleStream(msg)
  }

  const controller = new AbortController()
  robot.brain.on('close', () => controller.abort())
  zulip.run(onEvent, {
    signal: controller.signal,
    onState: (connected, error) => {
      state.connected = connected
      if (error) {
        state.lastError = error
        robot.logger.warn(`relay: zulip ${error}`)
      }
    }
  }).catch(err => robot.logger.error(`relay: zulip loop stopped: ${err}`))
}
