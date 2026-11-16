// Description:
//   Links your Discord account to your GitHub account, so pushes to followed repos count toward
//   your commit streak. First come, first served: an account someone already claimed can only be
//   moved by the owner. Links are announced in the channel, so a wrong claim gets noticed.
//
// Commands:
//   hubot my github is <login> - Links your GitHub account.
//   hubot my github - Shows your linked GitHub account.
//   hubot forget my github - Unlinks your GitHub account.
//   hubot github link <user> <login> - (Owner only) Links an account for someone, moving it from whoever had it.
//   hubot github unlink <user> - (Owner only) Unlinks someone's account.
//
// Configuration:
//   OWNER_USER_ID - Discord user ID allowed to link and unlink for others.
//

import type { Robot, Response } from 'hubot'

import { GITHUB_LOGIN, githubLoginOf, setGithubLogin, userForGithubLogin } from './lib/githubUsers.ts'
import { required } from './lib/match.ts'
import { mentionFor } from './lib/mention.ts'
import { isOwner } from './lib/owner.ts'

// <@id>, or a name the brain knows
const resolveUser = (robot: Robot, who: string): string | undefined => {
  const mention = who.match(/^<@!?(\d+)>$/)
  if (mention) return mention[1]
  const users = robot.brain.usersForFuzzyName(who.replace(/^@/, ''))
  return users.length === 1 ? users[0]!.id : undefined
}

// "https://github.com/ada/" -> "ada"
const cleanLogin = (text: string): string => text.replace(/^<|>$/g, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/^@/, '').replace(/\/$/, '')

export default async (robot: Robot) => {
  robot.respond(/my github(?: is|=| =) ?(\S+)$/i, async res => {
    const userId = res.message.user.id
    const login = cleanLogin(required(res.match, 1))
    if (!GITHUB_LOGIN.test(login)) {
      await res.send(`"${login}" doesn't look like a GitHub username.`)
      return
    }
    const holder = userForGithubLogin(robot, login)
    if (holder && holder !== userId) {
      await res.send(`GitHub ${login} is already linked to ${mentionFor({ id: holder })}. If that's wrong, ask my owner to sort it out.`)
      return
    }
    const previous = githubLoginOf(robot, userId)
    setGithubLogin(robot, userId, login)
    const switched = previous && previous.toLowerCase() !== login.toLowerCase() ? ` (was ${previous})` : ''
    await res.send(`🔗 ${mentionFor({ id: userId, name: res.message.user.name })} linked GitHub ${login}${switched}. Pushes to repos I follow now count toward their commit streak.`)
  })

  robot.respond(/(?:what(?:'s| is) )?my github\??$/i, async res => {
    const login = githubLoginOf(robot, res.message.user.id)
    await res.send(login ? `You're linked to GitHub ${login}.` : `No GitHub account linked. \`${robot.name} my github is <username>\` links one.`)
  })

  robot.respond(/forget my github$/i, async res => {
    const userId = res.message.user.id
    const login = githubLoginOf(robot, userId)
    setGithubLogin(robot, userId, undefined)
    await res.send(login ? `Unlinked GitHub ${login}.` : 'No GitHub account was linked.')
  })

  robot.respond(/github link (\S+) (\S+)$/i, async res => {
    if (!isOwner(res)) {
      await res.send('Only my owner can link accounts for other people.')
      return
    }
    const userId = resolveUser(robot, required(res.match, 1))
    const login = cleanLogin(required(res.match, 2))
    if (!userId || !GITHUB_LOGIN.test(login)) {
      await res.send('Usage: `github link <@user> <github username>`.')
      return
    }
    const holder = userForGithubLogin(robot, login)
    if (holder && holder !== userId) setGithubLogin(robot, holder, undefined)
    setGithubLogin(robot, userId, login)
    const moved = holder && holder !== userId ? `, unlinking ${mentionFor({ id: holder })}` : ''
    await res.send(`🔗 Linked ${mentionFor({ id: userId })} to GitHub ${login}${moved}.`)
  })

  robot.respond(/github unlink (\S+)$/i, async res => {
    if (!isOwner(res)) {
      await res.send('Only my owner can unlink accounts for other people.')
      return
    }
    const userId = resolveUser(robot, required(res.match, 1))
    const login = userId ? githubLoginOf(robot, userId) : undefined
    if (!userId || !login) {
      await res.send("That person doesn't have a GitHub account linked.")
      return
    }
    setGithubLogin(robot, userId, undefined)
    await res.send(`Unlinked ${mentionFor({ id: userId })} from GitHub ${login}.`)
  })
}
