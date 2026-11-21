// Description:
//   Fetches a random joke, live. Defaults to a dad joke; categories pull from other sources.
//
// Commands:
//   hubot joke - Replies with a random dad joke.
//   hubot joke <category> - Replies with a joke from <category>, e.g. programming, pun, spooky or chuck.
//   hubot tell me a joke - Same as "joke".
//   hubot tell me a <category> joke - Same as "joke <category>".
//

import type { Robot, Response } from 'hubot'

import { defineFeature } from './lib/features.ts'
import { allows } from './lib/policy.ts'

defineFeature({ id: 'joke', label: 'Jokes', level: 'professional', web: true, help: ['hubot joke', 'hubot tell me a'] })
defineFeature({ id: 'joke.unfiltered', label: 'Edgier jokes (flagged ones still filtered)', level: 'casual' })
defineFeature({ id: 'joke.dark', label: 'Dark jokes', level: 'mature' })
defineFeature({ id: 'joke.chuck.explicit', label: 'Explicit Chuck Norris jokes', level: 'mature' })

// safe, flagged-filtered or unfiltered
type Filter = 'safe' | 'flagged' | 'none'
type JokeFetcher = (filter: Filter) => Promise<string | null>

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
  const data = await response.json() as DadJokeResponse
  return data.joke || null
}

const CHUCK_TRIES = 3

const fetchChuckNorrisJoke: JokeFetcher = async filter => {
  const safe = filter !== 'none'
  // safe skips the explicit category
  for (let i = 0; i < (safe ? CHUCK_TRIES : 1); i++) {
    const response = await fetch('https://api.chucknorris.io/jokes/random')
    if (!response.ok) return null
    const data = await response.json() as ChuckNorrisJokeResponse
    if (safe && data.categories?.includes('explicit')) continue
    return data.value || null
  }
  return null
}

const JOKE_API_CATEGORIES = ['programming', 'dark', 'pun', 'misc', 'spooky', 'christmas']

const JOKE_API_QUERY: Record<Filter, string> = {
  safe: '?safe-mode',
  flagged: '?blacklistFlags=nsfw,religious,political,racist,sexist,explicit',
  none: ''
}

const fetchJokeApiJoke = (category: string): JokeFetcher => async filter => {
  const url = `https://v2.jokeapi.dev/joke/${category}${JOKE_API_QUERY[filter]}`
  const response = await fetch(url)
  if (!response.ok) return null
  const data = await response.json() as JokeApiResponse
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
// no pings in the echo
const UNKNOWN_CATEGORY = (category: string, dark: boolean): string =>
  `I don't know the "${category.replace(/[<>@#&!]/g, '')}" category. Try: dad, chuck, ${JOKE_API_CATEGORIES.filter(c => dark || c !== 'dark').join(', ')}.`

const handleJoke = async (robot: Robot, res: Response, category?: string) => {
  const dark = allows(robot, res, 'joke.dark')
  const filter: Filter = dark ? 'none' : allows(robot, res, 'joke.unfiltered') ? 'flagged' : 'safe'
  if (!category) {
    await res.send(await fetchDadJoke(filter) || NO_JOKE)
    return
  }

  const key = category.toLowerCase()
  const fetchFn = key === 'dark' && !dark ? undefined : CATEGORIES[key]
  if (!fetchFn) {
    await res.send(UNKNOWN_CATEGORY(category, dark))
    return
  }

  const chuck: Filter = allows(robot, res, 'joke.chuck.explicit') ? 'none' : 'safe'
  await res.send(await fetchFn(fetchFn === fetchChuckNorrisJoke ? chuck : filter) || NO_JOKE)
}

export default async (robot: Robot) => {
  robot.respond(/(?:tell me an? (\S+) joke|joke(?:\s+(\S+))?|tell me a joke)$/i, { id: 'joke.tell' }, async res => {
    await handleJoke(robot, res, res.match[1] || res.match[2])
  })
}
