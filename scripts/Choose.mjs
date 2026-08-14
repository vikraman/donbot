// Description:
//   Random decisions and numbers via random.org, falls back to Math.random.
//
// Commands:
//   hubot choose <a> or <b> or <c> - Picks one option at random.
//   hubot roll a number between <min> and <max> - Picks a random integer in range.
//   hubot roll <N> numbers between <min> and <max> - Picks N random integers in range.
//

const RANDOM_ORG_TIMEOUT_MS = 3000

const fetchWithTimeout = async (url) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), RANDOM_ORG_TIMEOUT_MS)
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`random.org responded with ${response.status}`)
    const text = await response.text()
    if (/error/i.test(text)) throw new Error(`random.org error: ${text.trim()}`)
    return text
  } finally {
    clearTimeout(timer)
  }
}

const localRandomInts = (count, min, max) =>
  Array.from({ length: count }, () => min + Math.floor(Math.random() * (max - min + 1)))

const randomInts = async (count, min, max) => {
  try {
    const url = `https://www.random.org/integers/?num=${count}&min=${min}&max=${max}&col=1&base=10&format=plain&rnd=new`
    const text = await fetchWithTimeout(url)
    const numbers = text.trim().split('\n').map(Number).filter(n => !Number.isNaN(n))
    if (numbers.length !== count) throw new Error('unexpected random.org response')
    return numbers
  } catch {
    return localRandomInts(count, min, max)
  }
}

export default async (robot) => {
  robot.respond(/(?:choose|pick)\s+(.+)$/i, async res => {
    const options = res.match[1].split(/\s+or\s+/i).map(o => o.trim()).filter(Boolean)
    if (options.length < 2) {
      await res.send('Give me at least two options, separated by "or".')
      return
    }
    const [index] = await randomInts(1, 0, options.length - 1)
    await res.send(options[index])
  })

  robot.respond(/roll (?:a |an )?number (?:between|from) (-?\d+) (?:and|to) (-?\d+)$/i, async res => {
    const min = Math.min(Number(res.match[1]), Number(res.match[2]))
    const max = Math.max(Number(res.match[1]), Number(res.match[2]))
    const [number] = await randomInts(1, min, max)
    await res.send(`${number}`)
  })

  robot.respond(/roll (\d+) numbers (?:between|from) (-?\d+) (?:and|to) (-?\d+)$/i, async res => {
    const count = Math.min(Number(res.match[1]), 100)
    const min = Math.min(Number(res.match[2]), Number(res.match[3]))
    const max = Math.max(Number(res.match[2]), Number(res.match[3]))
    const numbers = await randomInts(count, min, max)
    await res.send(numbers.join(', '))
  })
}
