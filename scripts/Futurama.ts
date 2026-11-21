// Description:
//   Fetches a Futurama quote, live, with attribution. Optionally scoped to a character.
//
// Commands:
//   hubot quote - Replies with a random Futurama quote.
//   hubot quote <character> - Replies with a quote from <character>, e.g. "quote Bender".
//   hubot entertain me - Same as "quote".
//

import type { Robot } from 'hubot'
import { defineFeature } from './lib/features.ts'

defineFeature({ id: 'futurama', label: 'Futurama quotes', level: 'professional', web: true, help: ['hubot quote', 'hubot entertain me'] })

interface FuturamaQuote {
  quote: string
  who: string
}

interface FuturamaQuoteResponse {
  quote?: string
  who?: string
}

const BASE_URL = 'https://bender.sierrasoftworks.com/api/v1/quote'

const fetchQuote = async (character?: string): Promise<FuturamaQuote | null> => {
  const url = character ? `${BASE_URL}/${encodeURIComponent(character)}` : BASE_URL
  const response = await fetch(url)
  if (!response.ok) return null
  const data = await response.json() as FuturamaQuoteResponse
  return data.quote ? (data as FuturamaQuote) : null
}

const NO_QUOTE = "I don't have a quote for that."

export default async (robot: Robot) => {
  robot.respond(/quote(?:\s+(.+))?$/i, { id: 'futurama.quote' }, async res => {
    const character = res.match[1] ? res.match[1].trim() : undefined
    const result = await fetchQuote(character)
    await res.send(result ? `"${result.quote}" — ${result.who}` : NO_QUOTE)
  })

  robot.respond(/entertain me$/i, { id: 'futurama.entertain' }, async res => {
    const result = await fetchQuote()
    await res.send(result ? `"${result.quote}" — ${result.who}` : NO_QUOTE)
  })
}
