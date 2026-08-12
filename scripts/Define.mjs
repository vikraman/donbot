// Description:
//   Looks up a word's definition.
//
// Commands:
//   hubot define <word> - Shows the first definition of <word>.
//

export default async (robot) => {
  robot.respond(/(?:define|definition of|meaning of|what does)\s+(.+?)(?:\s+mean)?$/i, async res => {
    const word = res.match[1].trim()
    const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`)

    if (!response.ok) {
      await res.send(`No definition found for ${word}.`)
      return
    }

    const data = await response.json()
    const meaning = data[0] && data[0].meanings && data[0].meanings[0]
    const definition = meaning && meaning.definitions && meaning.definitions[0] && meaning.definitions[0].definition

    if (!definition) {
      await res.send(`No definition found for ${word}.`)
      return
    }

    await res.send(`${word} (${meaning.partOfSpeech}): ${definition}`)
  })
}
