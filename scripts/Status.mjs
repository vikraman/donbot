// Description:
//   Reports bot uptime, memory usage, and brain (redis) connectivity.
//
// Commands:
//   hubot status - Shows uptime, memory usage, and brain connectivity.
//

const formatUptime = seconds => {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return `${h}h ${m}m ${s}s`
}

export default async (robot) => {
  robot.respond(/(?:status|health(?:check)?|how are you(?: doing| feeling)?)$/i, async res => {
    const uptime = formatUptime(process.uptime())
    const mem = process.memoryUsage()
    const rss = (mem.rss / 1024 / 1024).toFixed(1)

    let brainStatus = 'unknown'
    try {
      const probeKey = 'status:probe'
      robot.brain.set(probeKey, Date.now())
      brainStatus = robot.brain.get(probeKey) ? 'connected' : 'unreachable'
    } catch {
      brainStatus = 'unreachable'
    }

    await res.send(`Uptime: ${uptime}\nMemory: ${rss} MB\nBrain: ${brainStatus}`)
  })
}
