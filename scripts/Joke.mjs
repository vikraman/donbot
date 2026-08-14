// Description:
//   Fetches a random joke, live. Defaults to a dad joke; categories pull from other sources.
//
// Commands:
//   hubot joke - Replies with a random dad joke.
//   hubot joke <category> - Replies with a joke from <category>: programming, dark, pun, misc, spooky, christmas, or chuck.
//   hubot tell me a joke - Same as "joke".
//   hubot tell me a <category> joke - Same as "joke <category>".
//

const fetchDadJoke = async () => {
  const response = await fetch('https://icanhazdadjoke.com/', { headers: { Accept: 'application/json' } })
  if (!response.ok) return null
  const data = await response.json()
  return data.joke || null
}

const fetchChuckNorrisJoke = async () => {
  const response = await fetch('https://api.chucknorris.io/jokes/random')
  if (!response.ok) return null
  const data = await response.json()
  return data.value || null
}

const JOKE_API_CATEGORIES = ['programming', 'dark', 'pun', 'misc', 'spooky', 'christmas']

const fetchJokeApiJoke = category => async () => {
  const url = `https://v2.jokeapi.dev/joke/${category}`
  const response = await fetch(url)
  if (!response.ok) return null
  const data = await response.json()
  if (data.error) return null
  return data.type === 'twopart' ? `${data.setup} ${data.delivery}` : data.joke
}

const CATEGORIES = {
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
const UNKNOWN_CATEGORY = category => `I don't know the "${category}" category. Try: dad, chuck, ${JOKE_API_CATEGORIES.join(', ')}.`

const handleJoke = async (res, category) => {
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

export default async (robot) => {
  robot.respond(/(?:tell me an? (\S+) joke|joke(?:\s+(\S+))?|tell me a joke)$/i, async res => {
    await handleJoke(res, res.match[1] || res.match[2])
  })
}
