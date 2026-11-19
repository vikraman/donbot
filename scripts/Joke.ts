// Description:
//   Fetches a random joke, live. Defaults to a dad joke; categories pull from other sources.
//
// Commands:
//   hubot joke - Replies with a random dad joke.
//   hubot joke <category> - Replies with a joke from <category>: programming, dark, pun, misc, spooky, christmas, or chuck.
//   hubot tell me a joke - Same as "joke".
//   hubot tell me a <category> joke - Same as "joke <category>".
//

import type { Robot, Response } from 'hubot'

import { isWebRoom } from './lib/web.ts'

// safe: family-friendly only, for web visitors
type JokeFetcher = (safe: boolean) => Promise<string | null>

interface DadJokeResponse {
  joke?: string
}

interface ChuckNorrisJokeResponse {
  value?: string
  categories?: string[]
}

interface JokeApiResponse {
  error?: boolean
  type?: 'single' | 'twopart'
  joke?: string
  setup?: string
  delivery?: string
}

const fetchDadJoke: JokeFetcher = async () => {
  const response = await fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' } })
  if (!response.ok) return null
  const data: DadJokeResponse = await response.json()
  return data.joke || null
}

const CHUCK_TRIES = 3

const fetchChuckNorrisJoke: JokeFetcher = async safe => {
  // safe skips the explicit category
  for (let i = 0; i < (safe ? CHUCK_TRIES : 1); i++) {
    const response = await fetch('https://api.chucknorris.io/jokes/random')
    if (!response.ok) return null
    const data: ChuckNorrisJokeResponse = await response.json()
    if (safe && data.categories?.includes('explicit')) continue
    return data.value || null
  }
  return null
}

const JOKE_API_CATEGORIES = ['programming', 'dark', 'pun', 'misc', 'spooky', 'christmas']
const UNSAFE_CATEGORIES = new Set(['dark'])

const fetchJokeApiJoke = (category: string): JokeFetcher => async safe => {
  // safe-mode drops dark and flagged jokes
  const url = `https://v2.jokeapi.dev/joke/${category}${safe ? '?safe-mode' : ''}`
  const response = await fetch(url)
  if (!response.ok) return null
  const data: JokeApiResponse = await response.json()
  if (data.error) return null
  return data.type === 'twopart' ? `${data.setup} ${data.delivery}` : data.joke || null
}

const CATEGORIES: Record<string, JokeFetcher> = {
  dad: fetchDadJoke,
  chuck: fetchChuckNorrisJoke,
  chucknorris: fetchChuckNorrisJoke,
  coding: fetchJokeApiJoke('Programming'),
  development: fetchJokeApiJoke('Programming'),
  halloween: fetchJokeApiJoke('Spooky'),
  miscellaneous: fetchJokeApiJoke('Misc'),
  ...Object.fromEntries(JOKE_API_CATEGORIES.map(c => [c.toLowerCase(), fetchJokeApiJoke(c)]))
}

const NO_JOKE = "I don't have a joke for you right now."
const UNKNOWN_CATEGORY = (category: string, safe: boolean): string =>
  `I don't know the "${category}" category. Try: dad, chuck, ${JOKE_API_CATEGORIES.filter(c => !safe || !UNSAFE_CATEGORIES.has(c)).join(', ')}.`

const handleJoke = async (res: Response, category?: string) => {
  const safe = isWebRoom(res.message.room)
  if (!category) {
    await res.send(await fetchDadJoke(safe) || NO_JOKE)
    return
  }

  const key = category.toLowerCase()
  const fetchFn = safe && UNSAFE_CATEGORIES.has(key) ? undefined : CATEGORIES[key]
  if (!fetchFn) {
    await res.send(UNKNOWN_CATEGORY(category, safe))
    return
  }

  await res.send(await fetchFn(safe) || NO_JOKE)
}

export default async (robot: Robot) => {
  robot.respond(/(?:tell me an? (\S+) joke|joke(?:\s+(\S+))?|tell me a joke)$/i, { id: 'joke.tell' }, async res => {
    await handleJoke(res, res.match[1] || res.match[2])
  })
}
