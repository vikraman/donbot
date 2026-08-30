// Description:
//   Keeps a pool of random.org values in the brain so the sync random helpers
//   can draw true randomness without blocking on the network.
//
// Configuration:
//   RANDOM_ORG_API_KEY - API key for random.org true RNG (https://api.random.org/dashboard). Optional; falls back to secure local randomness without it.
//

import type { Robot } from 'hubot'

import { useRandomPool } from './lib/random.ts'

export default async (robot: Robot) => {
  // brain reads are only meaningful once redis has loaded
  robot.brain.on('connected', () => useRandomPool(robot))
}
