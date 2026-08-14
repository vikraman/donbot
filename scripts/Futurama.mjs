// Description:
//   Fetches a Futurama quote, live, with attribution. Optionally scoped to a character.
//
// Commands:
//   hubot quote - Replies with a random Futurama quote.
//   hubot quote <character> - Replies with a quote from <character>, e.g. "quote Bender".
//   hubot entertain me - Same as "quote".
//

const BASE_URL = 'https://bender.sierrasoftworks.com/api/v1/quote'

const fetchQuote = async (character) => {
  const url = character ? `${BASE_URL}/${encodeURIComponent(character)}` : BASE_URL
  const response = await fetch(url)
  if (!response.ok) return null
  const data = await response.json()
  return data.quote ? data : null
}

const NO_QUOTE = "I don't have a quote for that."

export default async (robot) => {
  robot.respond(/quote(?:\s+(.+))?$/i, async res => {
    const character = res.match[1] ? res.match[1].trim() : null
    const result = await fetchQuote(character)
    await res.send(result ? `"${result.quote}" — ${result.who}` : NO_QUOTE)
  })

  robot.respond(/entertain me$/i, async res => {
    const result = await fetchQuote()
    await res.send(result ? `"${result.quote}" — ${result.who}` : NO_QUOTE)
  })
}
