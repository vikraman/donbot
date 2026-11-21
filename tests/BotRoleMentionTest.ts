import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

import type { DiscordMessage } from 'hubot'

import { setupRobot, collect, brainUser } from './helpers/setup.ts'

const BOT_ID = 'bot-1'

// raw discord message with the given role mentions
const raw = (roles: Record<string, string | undefined>): DiscordMessage => ({
  mentions: { roles: new Map(Object.entries(roles).map(([id, botId]) => [id, { tags: botId ? { botId } : null }])) }
} as unknown as DiscordMessage)

describe('BotRoleMention', () => {
  const state = setupRobot('BotRoleMention.ts')
  beforeEach(() => {
    state.robot.adapter.client = { user: { id: BOT_ID } }
    state.robot.respond(/ping (\S+)$/i, async res => { await res.send(`pong ${res.match[1]}`) })
  })

  const say = async (text: string, roles: Record<string, string | undefined>) => {
    const user = brainUser(state.robot, 'u1', 'alice')
    user.message = raw(roles)
    await state.robot.adapter.say(user, text, 'room-a')
  }

  it("answers a mention of the bot's own role", async () => {
    const sent = collect(state.robot)
    await say('<@&111> ping freeCodeCamp/freeCodeCamp', { 111: BOT_ID })
    await say('<@&111>ping tight', { 111: BOT_ID })
    assert.deepStrictEqual(sent, ['pong freeCodeCamp/freeCodeCamp', 'pong tight'])
  })

  it('ignores other roles and mid-message role mentions', async () => {
    const sent = collect(state.robot)
    await say('<@&222> ping x', { 222: undefined })
    await say('<@&333> ping x', { 333: 'other-bot' })
    await say('hey <@&111> ping x', { 111: BOT_ID })
    await say('<@&444> ping x', {})
    assert.deepStrictEqual(sent, [])
  })

  it('leaves normal mentions alone', async () => {
    const sent = collect(state.robot)
    await say(`@${state.robot.name} ping y`, {})
    assert.deepStrictEqual(sent, ['pong y'])
  })
})
