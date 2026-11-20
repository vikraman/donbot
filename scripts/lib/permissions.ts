import type { Response } from 'hubot'

import { isOwner } from './owner.ts'
import { isWebRoom } from './web.ts'

// who may change settings

export type ManageScope = 'guild' | 'channel' | 'roles'

interface PermissionsLike {
  has: (flag: string) => boolean
}

interface RawMember {
  permissions?: PermissionsLike
}

interface RawMessage {
  guildId?: string | null
  member?: RawMember | null
  channel?: { permissionsFor?: (member: RawMember) => PermissionsLike | null }
}

const FLAG: Record<ManageScope, string> = { guild: 'ManageGuild', channel: 'ManageChannels', roles: 'ManageRoles' }

export const canManage = (res: Response, scope: ManageScope): boolean => {
  if (isOwner(res)) return true
  if (isWebRoom(res.message.room)) return false
  const raw = res.message.user?.message as RawMessage | undefined
  if (!raw) return false
  // discord.js sets guildId to null in dms
  if (raw.guildId === null) return true
  const member = raw.member
  if (!member) return false
  try {
    if (member.permissions?.has(FLAG.guild)) return true
    if (scope === 'roles') return Boolean(member.permissions?.has(FLAG.roles))
    // channel overwrites
    return scope === 'channel' && Boolean(raw.channel?.permissionsFor?.(member)?.has(FLAG.channel))
  } catch {
    return false
  }
}

export const MANAGE_ONLY: Record<ManageScope, string> = {
  guild: 'Only someone who can manage this server can do that.',
  channel: 'Only someone who can manage this channel can do that.',
  roles: 'In professional servers, only someone who can manage roles can do that.'
}
