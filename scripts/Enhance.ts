// Description:
//   Cleans up whiteboard and blackboard photos: finds the board, evens its lighting, keeps ink colours,
//   crops and straightens it, and replies with the result. Nothing is kept.
//
// Commands:
//   hubot enhance [settings] - Enhances the photos on this message, or on the message it replies to.
//   hubot enhance help - Lists the settings.
//
// Notes:
//   Settings combine: a preset (mild, strong, off) first, then anything to override it, e.g. "enhance strong, color 100, nocrop".
//   brightness 0-100 lifts a whiteboard towards white, contrast 0-100 deepens the writing, color 0-200 is saturation,
//   clean off/low/normal/high clears faint marks, straighten/box/nocrop picks the crop, whiteboard/blackboard overrides detection.
//   Photos are resized to 2000px and stripped of metadata (including location).
//

import type { Robot, Response } from 'hubot'

import { rawMessageOf } from './lib/discordMessage.ts'
import { defineFeature } from './lib/features.ts'
import { describeOptions, PRESETS, resolveEnhance } from './lib/enhance/board.ts'
import type { Preset } from './lib/enhance/board.ts'
import { imagesOf, MAX_PHOTOS, processPhotos } from './lib/enhance/photos.ts'
import type { WithAttachments } from './lib/enhance/photos.ts'
import { ENHANCE_HELP, parseEnhanceSpec } from './lib/enhance/settings.ts'
import { postFiles } from './lib/rooms.ts'

defineFeature({ id: 'enhance', label: 'Board photo enhancement', level: 'professional', help: ['hubot enhance'] })

// discord upload limit, all files
const MAX_BYTES = 8 * 1024 * 1024

interface Msg extends WithAttachments {
  id?: string
  reference?: { messageId?: string } | null
  channel?: { messages?: { fetch: (id: string) => Promise<Msg> } }
}

const HELP = [
  `Post photos with \`enhance [settings]\`, or reply to a message with photos. Settings: ${ENHANCE_HELP}.`,
  'A preset comes first and the rest override it, e.g. `enhance strong, color 100, nocrop` or `enhance off, straighten`.',
  ...(Object.keys(PRESETS) as Preset[]).map(p => `\`${p}\`: ${describeOptions(PRESETS[p])}`),
  'Without settings it uses `mild`.'
].join('\n')

export default async (robot: Robot) => {
  robot.respond(/enhance(?:\s+([\s\S]*))?$/i, { id: 'enhance.run' }, async (res: Response) => {
    const args = (res.match[1] ?? '').trim()
    if (/^(help|\?)$/i.test(args)) {
      await res.send(HELP)
      return
    }
    const raw = rawMessageOf(res) as unknown as Msg | undefined
    let source = raw
    // replied-to message
    if (raw && !imagesOf(raw).length && raw.reference?.messageId && raw.channel?.messages) {
      try {
        source = await raw.channel.messages.fetch(raw.reference.messageId)
      } catch {
        source = undefined
      }
    }
    const count = source ? Math.min(imagesOf(source).length, MAX_PHOTOS) : 0
    if (!source || !count) {
      await res.send(`Attach photos to your \`${robot.name} enhance\` message, or reply to a message that has them.`)
      return
    }
    const { spec, errors } = parseEnhanceSpec(args)
    if (errors.length) {
      await res.send(`${errors.join(', ')}. Settings: ${ENHANCE_HELP}.`)
      return
    }
    const done = await processPhotos(source, Math.floor(MAX_BYTES / count), resolveEnhance(spec))
    const files = done.flatMap((p, i) => p.photo ? [{ data: p.photo.data, name: `enhanced-${i + 1}.jpg` }] : [])
    await postFiles(robot, res.message.room, done.map(p => p.line).join('\n'), files, { feature: 'enhance', ...raw?.id ? { replyTo: raw.id } : {} })
  })
}
