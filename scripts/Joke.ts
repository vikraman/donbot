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

type JokeFetcher = () => Promise<string | null>

interface DadJokeResponse {
  joke?: string
}

interface ChuckNorrisJokeResponse {
  value?: string
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

const fetchChuckNorrisJoke: JokeFetcher = async () => {
  const response = await fetch('https://api.chucknorris.io/jokes/random')
  if (!response.ok) return null
  const data: ChuckNorrisJokeResponse = await response.json()
  return data.value || null
}

const JOKE_API_CATEGORIES = ['programming', 'dark', 'pun', 'misc', 'spooky', 'christmas']

const fetchJokeApiJoke = (category: string): JokeFetcher => async () => {
  const url = `https://v2.jokeapi.dev/joke/${category}`
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
const UNKNOWN_CATEGORY = (category: string): string =>
  `I don't know the "${category}" category. Try: dad, chuck, ${JOKE_API_CATEGORIES.join(', ')}.`

const handleJoke = async (res: Response, category?: string) => {
  if (!category) {
    await res.send(await fetchDadJoke() || NO_JOKE)
    return
  }

  const fetchFn = CATEGORIES[category.toLowerCase()]
  if (!fetchFn) {
    await res.send(UNKNOWN_CATEGORY(category))
    return
  }

  await res.send(await fetchFn() || NO_JOKE)
}

export default async (robot: Robot) => {
  robot.respond(/(?:tell me an? (\S+) joke|joke(?:\s+(\S+))?|tell me a joke)$/i, async res => {
    await handleJoke(res, res.match[1] || res.match[2])
  })
}
