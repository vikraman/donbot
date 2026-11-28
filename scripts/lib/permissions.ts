import type { Response } from 'hubot'

import { isOwner, isOwnerId } from './owner.ts'
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

type ChannelPerms = { permissionsFor?: (member: RawMember) => PermissionsLike | null } | undefined

// server, scope or channel rights
const memberMay = (member: RawMember, channel: ChannelPerms, scope: ManageScope): boolean => {
  try {
    if (member.permissions?.has(FLAG.guild)) return true
    if (scope === 'roles') return Boolean(member.permissions?.has(FLAG.roles))
    return scope === 'channel' && Boolean(channel?.permissionsFor?.(member)?.has(FLAG.channel))
  } catch {
    return false
  }
}

// dms: false for group resources
export const canManage = (res: Response, scope: ManageScope, { dms = true }: { dms?: boolean } = {}): boolean => {
  if (isOwner(res)) return true
  if (isWebRoom(res.message.room)) return false
  const raw = res.message.user?.message as RawMessage | undefined
  if (!raw) return false
  // discord.js sets guildId to null in dms
  if (raw.guildId === null) return dms
  return Boolean(raw.member) && memberMay(raw.member!, raw.channel, scope)
}

export const MANAGE_ONLY: Record<ManageScope, string> = {
  guild: 'Only someone who can manage this server can do that.',
  channel: 'Only someone who can manage this channel can do that.',
  roles: 'In professional servers, only someone who can manage roles can do that.'
}

interface MemberMessage {
  guildId?: string | null
  guild?: { members?: { fetch?: (id: string) => Promise<RawMember> } } | null
  channel?: { permissionsFor?: (member: RawMember) => PermissionsLike | null }
}

// for reaction handlers, no dms
export const canManageMember = async (message: MemberMessage, userId: string, scope: ManageScope = 'channel'): Promise<boolean> => {
  if (isOwnerId(userId)) return true
  if (!message.guildId) return false
  try {
    const member = await message.guild?.members?.fetch?.(userId)
    return Boolean(member) && memberMay(member!, message.channel, scope)
  } catch {
    return false
  }
}
