// Description:
//   Looks up a word's definition.
//
// Commands:
//   hubot define <word> - Shows the first definition of <word>.
//

import type { Robot } from 'hubot'

import { required } from './lib/match.ts'

interface DictionaryEntry {
  meanings?: {
    partOfSpeech: string
    definitions?: { definition: string }[]
  }[]
}

export default async (robot: Robot) => {
  robot.respond(/(?:define|definition of|meaning of|what does)\s+(.+?)(?:\s+mean)?$/i, async res => {
    const word = required(res.match, 1).trim()
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)

    if (!response.ok) {
      await res.send(`No definition found for ${word}.`)
      return
    }

    const data: DictionaryEntry[] = await response.json()
    const meaning = data[0] && data[0].meanings && data[0].meanings[0]
    const definition = meaning && meaning.definitions && meaning.definitions[0] && meaning.definitions[0].definition

    if (!definition) {
      await res.send(`No definition found for ${word}.`)
      return
    }

    await res.send(`${word} (${meaning.partOfSpeech}): ${definition}`)
  })
}
