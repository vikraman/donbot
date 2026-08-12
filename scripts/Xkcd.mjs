// Description:
//   Shows an xkcd comic.
//
// Commands:
//   hubot xkcd - Shows the latest xkcd comic.
//   hubot xkcd <number> - Shows xkcd comic <number>.
//

export default async (robot) => {
  robot.respond(/xkcd(?: comic)?\s*(\d+)?$/i, async res => {
    const number = res.match[1]
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
