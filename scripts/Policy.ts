// Description:
//   Decides what donbot does where. Servers and channels are professional or casual, and features can be
//   turned on or off on top. New servers start professional. Mature features only ever go on one at a time,
//   in age-restricted channels.
//
// Commands:
//   hubot settings - Shows the mode and feature changes for this channel and server.
//   hubot mode professional|casual [server|channel] - Sets the mode (server by default; Manage Server or Manage Channels).
//   hubot mode default channel - Makes this channel follow the server's mode again.
//   hubot enable <feature> [server|channel] - Turns a feature on (this channel by default).
//   hubot disable <feature> [server|channel] - Turns a feature off.
//   hubot reset <feature> [server|channel] - Drops a feature's on/off setting, back to the mode's default.
//   hubot features - Lists every feature, its level, and whether it's on here.
//   hubot privacy - Shows what donbot reads or keeps in this channel.
//   hubot puns|pep talks|reactions|ai lines|github nudges [on|off] - Same as enable/disable for this channel.
//   hubot help [query] - Lists the commands available here.
//

import type { Response, Robot } from 'hubot'

import { defineFeature, featureById, features, type Feature, type Level } from './lib/features.ts'
import { installGate } from './lib/gate.ts'
import { helpLines } from './lib/help.ts'
import { configureLines } from './lib/lines.ts'
import { canManage, MANAGE_ONLY, type ManageScope } from './lib/permissions.ts'
import { isOwner } from './lib/owner.ts'
import { defineMigration, fetchRoom, guildIds, installMigrations } from './lib/migrations.ts'
import { policyFor, type Mode, type RawLike, type Rec } from './lib/policy.ts'

defineFeature({ id: 'policy', label: 'Settings', level: 'professional', locked: true, help: ['hubot settings', 'hubot mode', 'hubot enable', 'hubot disable', 'hubot reset', 'hubot features', 'hubot privacy', 'hubot puns|'] })
defineFeature({ id: 'help', label: 'Help', level: 'professional', locked: true, web: true, help: ['hubot help'] })

// old toggle words
const ALIASES: Record<string, string> = {
  puns: 'puns',
  'pep talks': 'peptalk',
  reactions: 'reactemoji',
  'ai lines': 'lines.ai',
  'github nudges': 'github.nudges'
}

// legacy roomToggle keys
const OLD_TOGGLES: Record<string, string> = {
  'puns:disabled': 'puns',
  'peptalk:disabled': 'peptalk',
  'reactemoji:disabled': 'reactemoji',
  'lines:ai-off': 'lines.ai',
  'github:nudges-off': 'github.nudges'
}

const LEVEL_LABEL: Record<Level, string> = { professional: 'Professional', casual: 'Casual', mature: 'Mature' }

const rec = (): Rec => ({ on: [], off: [] })

// legacy data means grandfathering
const LEGACY_SIGNS = [...Object.keys(OLD_TOGGLES), 'seen:last']

defineMigration({
  id: '001-policy',
  run: async robot => {
    const policy = policyFor(robot)
    // fresh brain stays professional
    const legacy = LEGACY_SIGNS.some(key => robot.brain.get(key) != null) || Object.keys(robot.brain.data.users || {}).length > 0
    // rooms may be threads or dms
    const moves: Array<{ table: 'channels' | 'dms', key: string, feature: string }> = []
    for (const [key, feature] of Object.entries(OLD_TOGGLES)) {
      const rooms = robot.brain.get<Record<string, unknown>>(key)
      if (!rooms || typeof rooms !== 'object') continue
      for (const room of Object.keys(rooms)) {
        await fetchRoom(robot, room)
        const scope = policy.scopeOf(room)
        if (scope.kind === 'dm' && scope.user) moves.push({ table: 'dms', key: scope.user, feature })
        else moves.push({ table: 'channels', key: scope.channel ?? room, feature })
      }
    }
    const guilds = legacy ? guildIds(robot) : []
    const now = Date.now()
    policy.update(d => {
      for (const id of guilds) d.guilds[id] ??= { mode: 'casual', on: [], off: [], by: 'migration', at: now }
      for (const { table, key, feature } of moves) {
        const r = d[table][key] ??= rec()
        if (!r.off.includes(feature)) r.off.push(feature)
      }
    })
    for (const key of Object.keys(OLD_TOGGLES)) robot.brain.remove(key)
    robot.logger.info(`policy: grandfathered ${guilds.length} servers as casual`)
  }
})

export default async (robot: Robot) => {
  const policy = policyFor(robot)
  installGate(robot)
  // no room is professional
  configureLines({ casual: (room, feature) => Boolean(room) && policy.allowsRoom(room!, feature) })

  installMigrations(robot)

  const rawOf = (res: Response): RawLike | undefined => res.message.user?.message as RawLike | undefined

  interface Target {
    table: 'guilds' | 'channels' | 'dms'
    key: string
    manage: ManageScope
    label: string
  }

  const targetFor = (res: Response, where: string | undefined, fallback: 'server' | 'channel'): Target | string => {
    const scope = policy.scopeOf(res.message.room, rawOf(res))
    if (scope.kind === 'dm' && scope.user) return { table: 'dms', key: scope.user, manage: 'channel', label: 'our DMs' }
    if (scope.kind !== 'guild') return 'Settings can only be changed in a Discord server or DM.'
    return (where ?? fallback) === 'server'
      ? { table: 'guilds', key: scope.guild!, manage: 'guild', label: 'this server' }
      : { table: 'channels', key: scope.channel!, manage: 'channel', label: 'this channel' }
  }

  const authorize = async (res: Response, target: Target | string): Promise<Target | null> => {
    if (typeof target === 'string') {
      await res.send(target)
      return null
    }
    if (!canManage(res, target.manage)) {
      await res.send(MANAGE_ONLY[target.manage])
      return null
    }
    return target
  }

  const describeRec = (r: Rec | undefined): string => {
    if (!r || (!r.mode && r.on.length === 0 && r.off.length === 0)) return 'no changes'
    return [r.mode && `mode ${r.mode}`, r.on.length > 0 && `on: ${r.on.join(', ')}`, r.off.length > 0 && `off: ${r.off.join(', ')}`].filter(Boolean).join('; ')
  }

  const visible = (): Feature[] => features().filter(f => !f.infra)

  robot.respond(/settings$/i, { id: 'policy.settings' }, async res => {
    const raw = rawOf(res)
    const resolved = policy.resolve(res.message.room, raw)
    const { scope } = resolved
    const d = policy.data()
    const lines = [`Mode here: ${resolved.mode}.`]
    if (scope.kind === 'guild') {
      lines.push(`Server: ${describeRec(d.guilds[scope.guild!])}.`, `Channel: ${describeRec(d.channels[scope.channel!])}.`)
    } else if (scope.kind === 'dm') {
      lines.push(`Our DMs: ${describeRec(d.dms[scope.user!])}.`)
    }
    const off = visible().filter(f => !policy.allows(res, f.id) && f.level !== 'mature')
    if (off.length > 0) lines.push(`Off here: ${off.map(f => f.id).join(', ')}.`)
    const known = new Set(features().map(f => f.id))
    const stale = [...resolved.layers.flatMap(r => [...r.on, ...r.off])].filter(id => !known.has(id))
    if (stale.length > 0) lines.push(`No longer exist: ${[...new Set(stale)].join(', ')}.`)
    lines.push(`\`${robot.name} features\` lists everything; \`${robot.name} enable <feature>\` turns one on.`)
    await res.send(lines.join('\n'))
  })

  robot.respond(/mode(?: (professional|casual|default))?(?: (server|channel))?$/i, { id: 'policy.mode' }, async res => {
    const wanted = res.match[1]?.toLowerCase() as Mode | 'default' | undefined
    if (!wanted) {
      await res.send(`This channel is ${policy.modeOf(res.message.room, rawOf(res))}.`)
      return
    }
    const target = await authorize(res, targetFor(res, res.match[2]?.toLowerCase(), 'server'))
    if (!target) return
    if (wanted === 'default' && target.table !== 'channels') {
      await res.send(`Only a channel can go back to the default; ${target.label} is ${policy.modeOf(res.message.room, rawOf(res))}.`)
      return
    }
    policy.update(d => {
      const r = d[target.table][target.key] ??= rec()
      if (wanted === 'default') delete r.mode
      else r.mode = wanted
      r.by = res.message.user.name
      r.at = Date.now()
    })
    const now = policy.modeOf(res.message.room, rawOf(res))
    await res.send(wanted === 'default' ? `This channel follows the server again: ${now}.` : `${target.label[0]!.toUpperCase()}${target.label.slice(1)} is now ${wanted}.${now !== wanted ? ` This channel stays ${now}.` : ''}`)
  })

  const toggle = async (res: Response, action: 'enable' | 'disable' | 'reset', id: string, where?: string) => {
    const feature = featureById(id.toLowerCase())
    if (!feature || feature.infra) {
      await res.send(`There's no feature called \`${id}\`. \`${robot.name} features\` lists them.`)
      return
    }
    if (feature.locked && action === 'disable') {
      await res.send(`${feature.label} can't be turned off.`)
      return
    }
    const target = await authorize(res, targetFor(res, where, 'channel'))
    if (!target) return
    if (action === 'enable' && target.table === 'channels' && policy.resolve(res.message.room, rawOf(res)).serverOff?.includes(feature.id)) {
      await res.send(`${feature.label} is off for this whole server. Someone who can manage the server can undo that with \`${robot.name} reset ${feature.id} server\`.`)
      return
    }
    if (feature.level === 'mature' && action === 'enable') {
      const scope = policy.scopeOf(res.message.room, rawOf(res))
      if (scope.kind === 'dm' ? !isOwner(res) : target.table !== 'channels' || !scope.nsfw) {
        await res.send(scope.kind === 'dm'
          ? 'Only my owner can turn on mature features in DMs.'
          : 'Mature features can only be turned on one channel at a time, in an age-restricted channel.')
        return
      }
    }
    policy.update(d => {
      const r = d[target.table][target.key] ??= rec()
      r.on = r.on.filter(x => x !== feature.id)
      r.off = r.off.filter(x => x !== feature.id)
      if (action === 'enable') r.on.push(feature.id)
      if (action === 'disable') r.off.push(feature.id)
      r.by = res.message.user.name
      r.at = Date.now()
    })
    const blocked = policy.blockedBy(res, feature.id)
    const verb = action === 'reset' ? `back to the default for ${target.label}` : `${action === 'enable' ? 'on' : 'off'} for ${target.label}`
    // note when the effective state differs
    const expected = action === 'reset' ? undefined : action === 'enable'
    const note = expected === undefined || expected !== !blocked
      ? ` It's ${blocked ? 'off' : 'on'} here${blocked && blocked.id !== feature.id ? `, since \`${blocked.id}\` is off` : ''}.`
      : ''
    await res.send(`${feature.label}: ${verb}.${note}`)
  }

  robot.respond(/(enable|disable|reset) ([\w.-]+)(?: (server|channel))?$/i, { id: 'policy.toggle' }, async res => {
    await toggle(res, res.match[1]!.toLowerCase() as 'enable' | 'disable' | 'reset', res.match[2]!, res.match[3]?.toLowerCase())
  })

  robot.respond(/(puns|pep talks|reactions|ai lines|github nudges)(?: (on|off|status))?$/i, { id: 'policy.alias' }, async res => {
    const id = ALIASES[res.match[1]!.toLowerCase()]!
    const action = res.match[2]?.toLowerCase()
    if (action === 'on' || action === 'off') {
      await toggle(res, action === 'on' ? 'enable' : 'disable', id)
      return
    }
    const feature = featureById(id)
    await res.send(`${feature?.label ?? id}: ${policy.allows(res, id) ? 'on' : 'off'} here.`)
  })

  robot.respond(/features$/i, { id: 'policy.features' }, async res => {
    const byLevel = (level: Level) => visible().filter(f => f.level === level)
    // mature only where enableable
    const mature = isOwner(res) || Boolean(policy.scopeOf(res.message.room, rawOf(res)).nsfw)
    const levels: Level[] = mature ? ['professional', 'casual', 'mature'] : ['professional', 'casual']
    const lines = levels.map(level => {
      const items = byLevel(level).map(f => `${policy.allows(res, f.id) ? '✅' : '⛔'} ${f.id}${f.passive ? ' 👁' : ''}`)
      return `**${LEVEL_LABEL[level]}**: ${items.join(', ')}`
    })
    await res.send(`${lines.join('\n')}\n👁 reads ordinary messages or reactions; see \`${robot.name} privacy\`.`)
  })

  robot.respond(/privacy$/i, { id: 'policy.privacy' }, async res => {
    const passive = visible().filter(f => f.passive)
    const rows = passive.map(f => `${policy.allows(res, f.id) ? '👁 on ' : '⛔ off'} ${f.label}${f.stores ? `: ${f.stores}` : ''}`)
    await res.send([
      'What donbot reads or keeps from ordinary messages here:',
      ...rows,
      'Commands you send it are handled like any other message. Names, scores and seen times stay within this server, but anyone here can see them, including activity from channels they can\'t read.'
    ].join('\n'))
  })

  robot.respond(/help\??(?:\s+(.*))?$/i, { id: 'help.list' }, async res => {
    const query = res.match[1]?.trim()
    const lines = helpLines(robot, id => policy.allows(res, id), query)
    await res.send(lines.length > 0 ? lines.join('\n') : query ? "Nothing here matches that." : 'Nothing is enabled here.')
  })
}

