// Description:
//   Zoidberg's whoop whoop whoop, as an audio clip (autoplays in the web chat).
//
// Commands:
//   hubot whoop - Plays Zoidberg's whoop whoop whoop.
//   hubot zoidberg - Same as "whoop".
//

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import type { Robot } from 'hubot'
import { defineFeature } from './lib/features.ts'

defineFeature({ id: 'zoidberg', label: 'Zoidberg whoop', level: 'professional', web: true, help: ['hubot whoop', 'hubot zoidberg'] })

export const SOUND = 'zoidberg-whoop.mp3'
const file = fileURLToPath(new URL(`../assets/sounds/${SOUND}`, import.meta.url))
const TEXT = '(V) (°,,,,°) (V) whoop whoop whoop'

export default async (robot: Robot) => {
  const found = existsSync(file)
  if (!found) robot.logger.warn(`zoidberg: missing ${file}`)

  robot.respond(/(?:whoop(?:\s+whoop)*|zoidberg)$/i, { id: 'zoidberg.whoop' }, async res => {
    await res.send(TEXT)
    if (found) await res.send({ files: [{ file, name: SOUND, description: 'whoop whoop whoop' }] })
  })
}
