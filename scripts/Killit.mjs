// Description:
//   Make "Kill it with fire!" jokes
//
// Commands:
//   kill - hubot says 'Kill it, Kill it with fire!'
//

export default async (robot) => {
  robot.hear(/\bkill([A-Za-z0-9]*)\b/, async res => {
    if (Math.random() < 0.314) {
      await res.send('Kill it, kill it with fire!')
    }
  })
}
