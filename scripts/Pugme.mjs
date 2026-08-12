// Description:
//   Displays random dog images.
//
// Commands:
//   hubot pug me - Receive a random dog image.
//

export default async (robot) => {
  robot.respond(/pug me$/i, async res => {
    const response = await fetch('https://dog.ceo/api/breeds/image/random')
    const data = await response.json()
    await res.send(data.message)
  })
}
