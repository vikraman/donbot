import type { Robot } from 'hubot'

import { entriesWithPrefix } from './brainScan.ts'

const PREFIX = 'github:login:'

export const GITHUB_LOGIN = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i

export const githubLoginOf = (robot: Robot, userId: string): string | undefined => {
  const login = robot.brain.get(`${PREFIX}${userId}`)
  return typeof login === 'string' ? login : undefined
}

export const setGithubLogin = (robot: Robot, userId: string, login: string | undefined) => {
  if (login) robot.brain.set(`${PREFIX}${userId}`, login)
  else robot.brain.remove(`${PREFIX}${userId}`)
}

// discord user id for a github login, case-insensitively
export const userForGithubLogin = (robot: Robot, login: string): string | undefined => {
  const wanted = login.toLowerCase()
  return entriesWithPrefix<string>(robot, PREFIX, (v): v is string => typeof v === 'string')
    .find(([, l]) => l.toLowerCase() === wanted)?.[0]
}
