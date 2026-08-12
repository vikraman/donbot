// Description:
//   Shows an xkcd comic.
//
// Commands:
//   hubot xkcd - Shows the latest xkcd comic.
//   hubot xkcd <number> - Shows xkcd comic <number>.
//   hubot xkcd random - Shows a random xkcd comic.
//

export default async (robot) => {
  robot.respond(/xkcd(?: comic)?\s*(random|\d+)?$/i, async res => {
    let number = res.match[1]

    if (number && number.toLowerCase() === 'random') {
      const latestResponse = await fetch('https://xkcd.com/info.0.json')
      if (!latestResponse.ok) {
        await res.send("Couldn't find that comic.")
        return
      }
      const latest = await latestResponse.json()
      number = String(1 + Math.floor(Math.random() * latest.num))
    }

    const url = number ? `https://xkcd.com/${number}/info.0.json` : 'https://xkcd.com/info.0.json'
    const response = await fetch(url)

    if (!response.ok) {
      await res.send("Couldn't find that comic.")
      return
    }

    const data = await response.json()
    await res.send(`${data.title}: ${data.img}`)
  })
}
