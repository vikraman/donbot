// Description:
//   Posts public GitHub repo activity (issues, PRs, pushes, CI, releases) to subscribed channels.
//   Polls the GitHub API; quiet repos are polled less often, down to once an hour.
//
// Commands:
//   hubot github subscribe <owner/repo> [issues|prs|pushes|ci|releases|comments|all ...] [every <5m>] - Posts the repo's activity here. Defaults to everything but comments.
//   hubot github unsubscribe <owner/repo> [categories] - Stops some or all of a repo's activity here.
//   hubot github subscriptions - Lists the repos this channel follows, with polling stats.
//   hubot github poll [owner/repo] - Checks this channel's repos for news right now.
//   hubot github digest [week|month] - Sums up this channel's GitHub activity. Defaults to the past week.
//   hubot github nudge - Lists PRs here that have been waiting for a review.
//   hubot github nudges [on|off] - Turns the weekday 10am review nudge on or off here. On by default.
//
// Notes:
//   Also celebrates first merged PRs, merge milestones, releases and CI recoveries.
//
// Configuration:
//   GITHUB_TOKEN - Token with no scopes; without it GitHub allows only 60 requests an hour.
//   GITHUB_POLL_SECONDS - Default poll interval, 60 to 3600. Defaults to 60.
//   GITHUB_POLL_MAX_SECONDS - Longest interval a quiet repo backs off to. Defaults to 3600.
//   GITHUB_NUDGE_DAYS - How many days an unreviewed PR waits before a nudge. Defaults to 2.
//   DEFAULT_TIMEZONE - Timezone for the nudge schedule. Defaults to Europe/London.
//

import type { Robot } from 'hubot'

import { formatDuration, formatAgo } from './lib/duration.ts'
import { eventsSince, logEvent } from './lib/eventLog.ts'
import type { LogEntry } from './lib/eventLog.ts'
import { githubClient, parseRepo, shortSha, branchOf } from './lib/github.ts'
import type { GithubResponse } from './lib/github.ts'
import { userForGithubLogin } from './lib/githubUsers.ts'
import { required } from './lib/match.ts'
import { defineLines } from './lib/lines.ts'
import { allowsRoomAsync } from './lib/policy.ts'
import { postToRoom } from './lib/rooms.ts'
import { scheduler } from './lib/schedule.ts'
import { recordStreak } from './lib/streak.ts'
import { DAY_MS, nextOccurrence } from './lib/time.ts'
import type { Repeat } from './lib/time.ts'
import { defaultTz } from './lib/timezone.ts'
import { defineFeature } from './lib/features.ts'
import { spaceOf } from './lib/spaces.ts'

defineFeature({ id: 'github', label: 'GitHub', level: 'professional', help: ['hubot github'] })
defineFeature({ id: 'github.nudges', label: 'Weekday review nudges', level: 'professional', help: ['hubot github nudges'] })

export const CATEGORIES = ['issues', 'prs', 'pushes', 'ci', 'releases', 'comments'] as const
export type Category = typeof CATEGORIES[number]
const DEFAULT_CATEGORIES: Category[] = CATEGORIES.filter(c => c !== 'comments')

const ALIASES: Record<string, Category> = {
  issue: 'issues', issues: 'issues',
  pr: 'prs', prs: 'prs', pull: 'prs', pulls: 'prs',
  push: 'pushes', pushes: 'pushes', commit: 'pushes', commits: 'pushes',
  ci: 'ci', build: 'ci', builds: 'ci', action: 'ci', actions: 'ci',
  release: 'releases', releases: 'releases',
  comment: 'comments', comments: 'comments'
}

const SUBS_KEY = 'github:subs'
const CURSOR_PREFIX = 'github:cursor:'
const TICK_MS = 15 * 1000
const MIN_SEC = 60
const MAX_SEC = 3600
const FORCE_GUARD_MS = 15 * 1000
// 3 calls per repo per poll against the anonymous 60/h
const ANON_SEC_PER_REPO = 180
const RATE_FLOOR = 3
const MAX_IDLE = 20
const MAX_CI_KEYS = 200
const MAX_COMMITS = 3
const DISCORD_LIMIT = 2000
const SUPPRESS_EMBEDS = 1 << 2
const ZWSP = '​'
const ZERO_SHA = /^0+$/
// branch_deletion is skipped
const ACTIVITY_TYPES = ['push', 'force_push', 'branch_creation', 'pr_merge']
const MERGED_PREFIX = 'github:merged:'
const MERGE_MILESTONES = [10, 25, 50, 100, 250, 500]
const NUDGE_REPEAT: Repeat = { kind: 'weekly', days: [1, 2, 3, 4, 5], hour: 10, minute: 0 }
// older prs are usually abandoned, not waiting
const NUDGE_MAX_AGE_MS = 30 * DAY_MS
const NUDGE_PER_REPO = 3
const NUDGE_CHECKS_PER_REPO = 6

const firstPrCheer = defineLines('github.first-pr', {
  fallback: [
    '🎉 First merged PR from {who} here. Welcome aboard!',
    '🎉 {who} just landed their first PR here. Nice one!',
    "🎉 That's {who}'s first merged PR here. Welcome!",
    '🎉 {who} is officially a contributor. First PR, merged.',
    '🎉 A wild first PR from {who} appears, and it got merged!',
    '🎉 {who} has entered the commit history. Welcome!',
    "🎉 First merge for {who}. The repo's family tree just grew.",
    '🎉 {who} got their first PR in. May it be the first of many.',
    '🎉 Welcome to the contributors list, {who}.',
    '🎉 {who} shipped their first change here. Lovely stuff.',
    '🎉 First PR from {who}, merged and everything. Take a bow.',
    '🎉 {who} broke the seal: first merged PR here.'
  ],
  rare: [
    '🎉 {who} landed their first PR. I have ordered a tiny commemorative plaque.',
    '🎉 {who}\'s first merged PR! Somewhere a CI runner sheds a single tear of joy.'
  ],
  ai: { about: 'a welcome cheer for someone whose first pull request in a repository was just merged', slots: ['who'] }
})

const releaseCheer = defineLines('github.release', {
  fallback: [
    '🚀 {tag} is out!',
    '🚀 {tag} has shipped. Congrats!',
    '🚀 Ship it! {tag} is live.',
    '🚀 {tag} is out in the world. Go forth, little release.',
    '🚀 {tag} just left the launchpad.',
    '🚀 {tag} is live. Changelog readers, rejoice.',
    '🚀 Say hello to {tag}.',
    '🚀 {tag} is out the door. Nicely done, everyone.',
    '🚀 Fresh off the press: {tag}.',
    '🚀 {tag} has been released into the wild.',
    '🚀 {tag} shipped. Time for a small celebration.',
    '🚀 Another one: {tag} is out.'
  ],
  rare: ['🚀 {tag} is out! I would throw confetti, but I am a bot and have no hands.'],
  ai: { about: 'a short celebration for a newly published software release, naming the version tag', slots: ['tag'] }
})

const ciCheer = defineLines('github.ci-fixed', {
  fallback: [
    'Nice save!',
    'Back in the green. 🎉',
    'Crisis averted.',
    'Green again, well done.',
    'The build gremlins have been evicted.',
    'Order restored.',
    'Fixed. Everyone can breathe again.',
    'Green is a good colour on you.',
    'CI is happy, so I am happy.',
    'That red was getting awkward. Thanks.',
    'Pipeline mended.',
    'All checks passing. As nature intended.'
  ],
  rare: ['Green again. I lit a small candle for the flaky test that gave its life.']
})

const milestoneLine = defineLines('github.milestone', {
  fallback: [
    '🏆 That makes {count} merged PRs in {repo}!',
    '🏆 {repo} just hit {count} merged PRs.',
    '🏆 Merged PR number {count} for {repo}. Milestone!',
    '🏆 {count} merged PRs in {repo}. That\'s a lot of reviewing.',
    '🏆 {repo} reached {count} merged PRs. Cake is traditional.',
    '🏆 And that\'s {count} merged PRs in {repo}!',
    '🏆 {count} PRs merged into {repo} so far. Keep them coming.',
    '🏆 Milestone: {repo} now has {count} merged PRs.',
    '🏆 {repo} has {count} merged PRs under its belt.',
    '🏆 Round number alert: {count} merged PRs in {repo}.',
    '🏆 {count} merges in {repo}. The history books are thick.',
    '🏆 {repo}: {count} merged PRs and counting.'
  ]
})

const nudgeIntro = defineLines('github.nudge', {
  fallback: [
    '👀 These PRs are waiting for a review:',
    '👀 A few PRs could use a reviewer:',
    '👀 Review-hungry PRs, looking for a kind soul:',
    '👀 Got ten minutes? These PRs need eyes:',
    '👀 Some PRs have been waiting patiently for a review:',
    '👀 Reviews wanted:',
    '👀 These PRs are gathering dust. A review would help:',
    '👀 Your daily review menu:',
    '👀 Someone\'s work is waiting on you, maybe:',
    '👀 Review o\'clock. These are waiting:',
    '👀 Unreviewed and hopeful:',
    '👀 These PRs would love some attention:'
  ],
  rare: ['👀 These PRs have been waiting so long they have started writing poetry about it:']
})

const nudgeClear = defineLines('github.nudge-clear', {
  fallback: [
    'No PRs here have been waiting more than {days} for a review. 🎉',
    'Nothing has been waiting more than {days} for a review. Tidy! 🎉',
    'Review queue is clear (nothing older than {days}). 🎉',
    'All caught up: no PR has waited more than {days}. 🎉',
    'Every PR older than {days} has a review. Lovely. 🎉',
    'No neglected PRs here. Nothing over {days} without a review. 🎉',
    'Clean slate: no PRs waiting more than {days}. 🎉',
    'Reviews are up to date, nothing older than {days}. 🎉',
    'Not a single PR left waiting over {days}. 🎉',
    'Nobody\'s waiting on a review for more than {days}. 🎉'
  ]
})

interface RoomSub {
  events: Category[]
  interval?: number
  by: string
  at: number
}

type Subs = Record<string, Record<string, RoomSub>>

export interface Cursor {
  name: string
  // events from before the subscription never post
  since: number
  eventsEtag?: string
  seenEvents: string[]
  activityEtag?: string
  // unset until seeded
  seenActivity?: string[]
  runsEtag?: string
  runsSeeded?: boolean
  seenRuns: string[]
  ciState: Record<string, 'success' | 'failure'>
  pollInterval?: number
  idleTicks: number
  lastPollAt: number
  lastPostAt?: number
  lastError?: string
  nextPollAt: number
}

interface Payload {
  action?: string
  number?: number
  issue?: { number: number, title: string, html_url: string, pull_request?: unknown }
  comment?: { html_url: string, body?: string }
  pull_request?: { number: number }
  review?: { state?: string, html_url: string, body?: string | null }
  release?: { tag_name: string, name?: string | null, html_url?: string }
}

export interface GhEvent {
  id: string
  type: string
  created_at: string
  public?: boolean
  actor: { login: string, display_login?: string }
  payload: Payload
}

export interface Activity {
  id: number
  before: string
  after: string
  ref: string
  timestamp: string
  activity_type: string
  actor: { login: string } | null
}

export interface Run {
  id: number
  run_attempt?: number
  name: string
  workflow_id: number
  head_branch: string
  head_sha: string
  actor?: { login: string } | null
  conclusion: string | null
  html_url: string
  updated_at: string
}

interface Pull {
  number?: number
  title: string
  html_url: string
  merged?: boolean
  merged_at?: string | null
  draft?: boolean
  created_at?: string
  user?: { login: string } | null
  requested_reviewers?: { login: string }[]
  requested_teams?: { slug: string }[]
}

export type GithubKind = 'merged' | 'opened' | 'closed' | 'release' | 'ci-fixed'

// read by the recap; item tells prs from issues
export interface GithubLog extends LogEntry {
  room: string
  repo: string
  kind: GithubKind
  actor: string
  item?: 'pr' | 'issue'
  number?: number
  title?: string
  url?: string
}

type LogFields = Omit<GithubLog, 'ts' | 'room' | 'repo'>

interface Described {
  text: string
  log?: LogFields
}

interface MergedState {
  logins: string[]
  // unknown when the history was too long to count from one page
  count?: number
}

interface Compare {
  status: string
  total_commits: number
  html_url: string
  commits: { sha: string, html_url: string, commit: { message: string } }[]
}

interface RepoMeta { full_name: string, private: boolean, archived: boolean }

class RateLimited extends Error {
  until: number
  constructor (until: number) {
    super('rate limited')
    this.until = until
  }
}

const GH = 'https://github.com'

// discord treats a backslash before any punctuation as a literal
export const esc = (text: string): string =>
  text.replace(/\s+/g, ' ').trim()
    .replace(/[\\`*_~|[\]()<>]/g, '\\$&')
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    // escaped colon stops discord autolinking (and previewing) urls in text
    .replace(/\b(https?):\/\//gi, '$1\\://')

// <> keeps discord from previewing the link
export const link = (text: string, url: string): string =>
  `[${esc(text)}](<${url.replace(/[<> ]/g, encodeURIComponent)}>)`

const truncate = (text: string, n: number): string => {
  const flat = text.replace(/<!--[\s\S]*?-->/g, '').replace(/\s+/g, ' ').trim()
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat
}

const firstLine = (text: string): string => text.split('\n')[0] || ''

const repoLink = (name: string): string => `**${link(name, `${GH}/${name}`)}**`

const userLink = (actor: GhEvent['actor']): string => {
  const bot = actor.login.match(/^(.+)\[bot\]$/)
  const url = bot ? `${GH}/apps/${bot[1]}` : `${GH}/${actor.login}`
  return link(actor.display_login || actor.login, url)
}

const branchLink = (name: string, branch: string): string =>
  link(branch, `${GH}/${name}/tree/${branch.split('/').map(encodeURIComponent).join('/')}`)

const commitLink = (name: string, sha: string): string => link(shortSha(sha), `${GH}/${name}/commit/${sha}`)

const ticket = (n: number, title: string, url: string): string => link(`#${n} ${truncate(title, 100)}`, url)

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export const formatRunFailed = (name: string, run: Run): string => {
  const what = run.conclusion === 'timed_out' ? 'timed out' : 'failed'
  return `${repoLink(name)} ❌ CI ${link(run.name, run.html_url)} ${what} on ${branchLink(name, run.head_branch)} (${commitLink(name, run.head_sha)})`
}

export const formatRunFixed = (name: string, run: Run): string =>
  `${repoLink(name)} ✅ CI ${link(run.name, run.html_url)} is passing again on ${branchLink(name, run.head_branch)} (${commitLink(name, run.head_sha)})`

export const formatPush = (name: string, actor: GhEvent['actor'], branch: string, head: string, compare?: Compare): string => {
  const who = `${repoLink(name)} ${userLink(actor)}`
  const where = branchLink(name, branch)
  if (!compare) return `${who} pushed to ${where} (${commitLink(name, head)})`
  if (compare.status !== 'ahead') return `${who} force-pushed ${where} (${commitLink(name, head)})`
  const lines = [`${who} pushed ${link(plural(compare.total_commits, 'commit'), compare.html_url)} to ${where}`]
  for (const c of compare.commits.slice(-MAX_COMMITS)) {
    lines.push(`${commitLink(name, c.sha)} ${esc(truncate(firstLine(c.commit.message), 80))}`)
  }
  const more = compare.total_commits - Math.min(compare.commits.length, MAX_COMMITS)
  if (more > 0) lines.push(`…and ${more} more`)
  return lines.join('\n')
}

export const categoryOf = (e: GhEvent): Category | undefined => {
  const p = e.payload
  switch (e.type) {
    case 'IssuesEvent': return ['opened', 'closed', 'reopened'].includes(p.action || '') ? 'issues' : undefined
    case 'PullRequestEvent': return ['opened', 'closed', 'reopened'].includes(p.action || '') ? 'prs' : undefined
    case 'PullRequestReviewEvent': {
      // reviews also emit `updated` when edited
      if (p.action !== 'created' && p.action !== 'submitted') return undefined
      const state = (p.review?.state || '').toLowerCase()
      if (state === 'approved' || state === 'changes_requested') return 'prs'
      return state === 'commented' && p.review?.body ? 'comments' : undefined
    }
    case 'ReleaseEvent': return p.action === 'published' ? 'releases' : undefined
    case 'IssueCommentEvent': return p.action === 'created' ? 'comments' : undefined
    case 'PullRequestReviewCommentEvent': return p.action === 'created' ? 'comments' : undefined
    default: return undefined
  }
}

export interface Options {
  categories: Category[]
  interval?: number
  error?: string
}

const UNITS: Record<string, number> = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600 }

const parseDuration = (text: string): number | undefined => {
  const m = text.match(/^(\d+)\s*([a-z]*)$/)
  if (!m || !m[1]) return undefined
  const unit = m[2] ? UNITS[m[2]] : 60
  return unit ? Number(m[1]) * unit : undefined
}

export const parseOptions = (text: string): Options => {
  const tokens = text.toLowerCase().split(/[\s,]+/).filter(Boolean)
  const categories = new Set<Category>()
  let interval: number | undefined
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i] as string
    if (t === 'every') {
      let spec = tokens[i + 1] || ''
      if (/^\d+$/.test(spec) && tokens[i + 2] && UNITS[tokens[i + 2] as string]) spec += tokens[++i + 1]
      i++
      interval = parseDuration(spec)
      if (interval === undefined || interval < MIN_SEC || interval > MAX_SEC) {
        return { categories: [], error: 'Pick an interval between 1m and 1h, like `every 5m`.' }
      }
    } else if (t === 'all') {
      CATEGORIES.forEach(c => categories.add(c))
    } else if (ALIASES[t]) {
      categories.add(ALIASES[t] as Category)
    } else {
      return { categories: [], error: `I don't know "${esc(t)}". Pick from: ${CATEGORIES.join(', ')}, all.` }
    }
  }
  return { categories: CATEGORIES.filter(c => categories.has(c)), interval }
}

const clockUtc = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)} UTC`

// intervals in seconds, times in ms
export interface RepoStats {
  name: string
  events: Category[]
  base: number
  every: number
  max: number
  idleTicks: number
  lastPollAt: number
  nextPollAt: number
  lastPostAt?: number
  lastError?: string
}

export const formatRepoStatus = (s: RepoStats, now: number): string => {
  const pace = s.every > s.base
    ? `every ${formatDuration(s.every * 1000)}, backed off from ${formatDuration(s.base * 1000)} after ${plural(s.idleTicks, 'quiet poll')} (max ${formatDuration(s.max * 1000)})`
    : `every ${formatDuration(s.base * 1000)}`
  const next = s.nextPollAt > now ? `in ${formatDuration(s.nextPollAt - now, { round: Math.ceil })}` : 'now'
  const last = s.lastPollAt ? `${formatAgo(s.lastPollAt, now)} (${s.lastError ? `failed: ${esc(s.lastError)}` : 'ok'})` : 'never'
  return [
    `${repoLink(s.name)}: ${s.events.join(', ')}`,
    `Polling: ${pace}`,
    `Last poll: ${last}, next ${next}, last post ${s.lastPostAt ? formatAgo(s.lastPostAt, now) : 'never'}`
  ].join('\n')
}

export interface ApiStats {
  authed: boolean
  rate?: { remaining: number, limit?: number, reset: number }
  pausedUntil: number
}

export const formatApiStatus = (s: ApiStats, now: number): string => {
  const quota = s.rate ? `, ${s.rate.remaining}${s.rate.limit ? `/${s.rate.limit}` : ''} requests left, resets ${clockUtc(s.rate.reset)}` : ''
  const paused = now < s.pausedUntil ? `, paused until ${clockUtc(s.pausedUntil)}` : ''
  return `GitHub API: ${s.authed ? 'token' : 'no token'}${quota}${paused}`
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err)

const isBot = (login: string): boolean => /\[bot\]$/i.test(login)

export const isMergeMilestone = (n: number): boolean => MERGE_MILESTONES.includes(n) || (n >= 1000 && n % 1000 === 0)

const DIGEST_SPANS: Record<string, number> = { week: 7 * DAY_MS, month: 30 * DAY_MS }

const count = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

export const formatDigest = (entries: GithubLog[], period: string): string => {
  if (entries.length === 0) return `No GitHub activity here this ${period}.`
  const of = (kind: GithubKind, item?: 'pr' | 'issue') => entries.filter(e => e.kind === kind && (!item || e.item === item))
  const merged = of('merged')
  const releases = of('release')
  const totals = [
    merged.length && `${count(merged.length, 'PR')} merged`,
    of('opened', 'pr').length && `${count(of('opened', 'pr').length, 'PR')} opened`,
    of('opened', 'issue').length && `${count(of('opened', 'issue').length, 'issue')} opened`,
    of('closed', 'issue').length && `${count(of('closed', 'issue').length, 'issue')} closed`,
    releases.length && count(releases.length, 'release'),
    of('ci-fixed').length && count(of('ci-fixed').length, 'CI fix', 'CI fixes')
  ].filter(Boolean)
  const lines = [`📦 GitHub this ${period}: ${totals.join(', ') || 'nothing notable'}`]
  const item = (e: GithubLog) => {
    const label = `${e.repo}${e.number ? ` #${e.number}` : ''}${e.title ? ` ${truncate(e.title, 80)}` : ''}`
    return e.url ? link(label, e.url) : esc(label)
  }
  if (merged.length) {
    const recent = merged.slice(-3).reverse().map(item)
    lines.push(`Merged: ${recent.join(', ')}${merged.length > 3 ? `, and ${merged.length - 3} more` : ''}`)
  }
  if (releases.length) lines.push(`Released: ${releases.slice(-3).reverse().map(item).join(', ')}`)
  const tally = new Map<string, number>()
  for (const e of entries) {
    if (e.kind === 'closed' || !e.actor || isBot(e.actor)) continue
    tally.set(e.actor, (tally.get(e.actor) ?? 0) + 1)
  }
  const top = [...tally].sort((a, b) => b[1] - a[1]).slice(0, 3)
  if (top.length) lines.push(`Top contributors: ${top.map(([who, n]) => `${esc(who)} (${n})`).join(', ')}`)
  return lines.join('\n')
}

export default async (robot: Robot) => {
  let rateBlockedUntil = 0
  let rate: ApiStats['rate']
  let timer: ReturnType<typeof setInterval> | undefined
  let ticking = false
  const inflight = new Map<string, Promise<number>>()

  const config = () => {
    const defaultSec = Math.min(MAX_SEC, Math.max(MIN_SEC, Number(process.env.GITHUB_POLL_SECONDS) || MIN_SEC))
    const maxSec = Math.max(defaultSec, Number(process.env.GITHUB_POLL_MAX_SECONDS) || MAX_SEC)
    return { token: process.env.GITHUB_TOKEN || undefined, defaultSec, maxSec }
  }

  const getSubs = (): Subs => {
    const stored = robot.brain.get(SUBS_KEY)
    return isObject(stored) ? stored as Subs : {}
  }
  const setSubs = (subs: Subs) => robot.brain.set(SUBS_KEY, subs)

  const getCursor = (key: string): Cursor | undefined => {
    const stored = robot.brain.get(CURSOR_PREFIX + key)
    return isObject(stored) && typeof stored.name === 'string' ? stored as unknown as Cursor : undefined
  }
  const setCursor = (key: string, cursor: Cursor) => robot.brain.set(CURSOR_PREFIX + key, cursor)

  const freshCursor = (name: string): Cursor =>
    ({ name, since: Date.now(), seenEvents: [], seenRuns: [], ciState: {}, idleTicks: 0, lastPollAt: 0, nextPollAt: 0 })

  const roomsFor = (rooms: Record<string, RoomSub>, cat: Category): string[] =>
    Object.keys(rooms).filter(room => rooms[room]?.events.includes(cat))

  const baseSeconds = (key: string, cursor: Cursor, subs: Subs): number => {
    const { token, defaultSec } = config()
    const rooms = Object.values(subs[key] || {})
    let base = rooms.length ? Math.min(...rooms.map(r => r.interval ?? defaultSec)) : defaultSec
    base = Math.max(base, cursor.pollInterval ?? 0, MIN_SEC)
    if (!token) base = Math.max(base, ANON_SEC_PER_REPO * Object.keys(subs).length)
    return base
  }

  const effectiveSeconds = (key: string, cursor: Cursor, subs: Subs): number => {
    const base = baseSeconds(key, cursor, subs)
    return Math.min(Math.max(config().maxSec, base), base * 2 ** cursor.idleTicks)
  }

  const call = async <T>(path: string, etag?: string): Promise<GithubResponse<T>> => {
    const res = await githubClient(config().token).get<T>(path, etag)
    const reset = (res.rateReset ?? 0) * 1000
    if (res.rateRemaining !== undefined) rate = { remaining: res.rateRemaining, limit: res.rateLimit, reset }
    if (res.rateRemaining !== undefined && res.rateRemaining <= RATE_FLOOR && reset > Date.now()) rateBlockedUntil = reset
    if ((res.status === 403 || res.status === 429) && res.rateRemaining === 0) throw new RateLimited(reset)
    return res
  }

  const deliver = async (room: string, text: string) => {
    if (!await allowsRoomAsync(robot, room, 'github')) return
    const content = text.length > DISCORD_LIMIT ? `${text.slice(0, DISCORD_LIMIT - 1)}…` : text
    const channel = robot.adapter.client?.channels?.cache?.get(room)
    try {
      if (channel?.send) await channel.send({ content, flags: SUPPRESS_EMBEDS, allowedMentions: { parse: [] } })
      else await postToRoom(robot, room, content)
    } catch (err) {
      robot.logger.warn(`github: couldn't post to ${room}: ${errorText(err)}`)
    }
  }

  const drop = async (key: string, name: string, why: string) => {
    const subs = getSubs()
    const rooms = Object.keys(subs[key] || {})
    delete subs[key]
    setSubs(subs)
    robot.brain.remove(CURSOR_PREFIX + key)
    for (const room of rooms) await deliver(room, `${repoLink(name)} ${why}, so I've stopped following it here.`)
  }

  const pull = async (name: string, n: number): Promise<Pull> => {
    const res = await call<Pull>(`/repos/${name}/pulls/${n}`)
    return res.body ?? { title: '', html_url: `${GH}/${name}/pull/${n}` }
  }

  const getMerged = (key: string): MergedState | undefined => {
    const stored = robot.brain.get(MERGED_PREFIX + key)
    return isObject(stored) && Array.isArray(stored.logins) ? stored as unknown as MergedState : undefined
  }

  // seeded lazily from one page of closed prs merged before this one; later ones in the batch still count as new
  const seedMerged = async (name: string, pr: Pull & { number: number }): Promise<MergedState | undefined> => {
    const res = await call<Pull[]>(`/repos/${name}/pulls?state=closed&per_page=100`)
    if (res.status !== 200 || !Array.isArray(res.body)) return undefined
    const cutoff = pr.merged_at ? Date.parse(pr.merged_at) : Infinity
    const merged = res.body.filter(p => p.merged_at && p.number !== pr.number && Date.parse(p.merged_at) < cutoff)
    const logins = [...new Set(merged.flatMap(p => p.user ? [p.user.login.toLowerCase()] : []))]
    return { logins, ...(res.body.length < 100 ? { count: merged.length } : {}) }
  }

  const celebrateMerge = async (name: string, pr: Pull & { number: number }, author: string): Promise<string[]> => {
    const key = name.toLowerCase()
    const state = getMerged(key) ?? await seedMerged(name, pr)
    if (!state) return []
    const lines: string[] = []
    const login = author.toLowerCase()
    if (!isBot(author) && !state.logins.includes(login)) {
      state.logins.push(login)
      lines.push(firstPrCheer({ who: userLink({ login: author }) }, { tz: defaultTz() }))
    }
    if (state.count !== undefined) {
      state.count++
      if (isMergeMilestone(state.count)) lines.push(milestoneLine({ count: state.count, repo: repoLink(name) }, { tz: defaultTz() }))
    }
    robot.brain.set(MERGED_PREFIX + key, state)
    return lines
  }

  const describe = async (name: string, e: GhEvent): Promise<Described | undefined> => {
    const p = e.payload
    const who = `${repoLink(name)} ${userLink(e.actor)}`
    switch (e.type) {
      case 'IssuesEvent': {
        if (!p.issue) return undefined
        const text = `${who} ${p.action} issue ${ticket(p.issue.number, p.issue.title, p.issue.html_url)}`
        if (p.action !== 'opened' && p.action !== 'closed') return { text }
        return { text, log: { kind: p.action, actor: e.actor.login, item: 'issue', number: p.issue.number, title: p.issue.title, url: p.issue.html_url } }
      }
      case 'PullRequestEvent': {
        const n = p.number ?? p.pull_request?.number
        if (n === undefined) return undefined
        const pr = await pull(name, n)
        const verb = p.action === 'closed' ? (pr.merged ? 'merged' : 'closed') : p.action
        const text = `${who} ${verb} PR ${ticket(n, pr.title, pr.html_url)}`
        if (verb !== 'merged' && verb !== 'closed' && verb !== 'opened') return { text }
        // credit the author, not whoever pressed merge
        const actor = verb === 'merged' ? pr.user?.login ?? e.actor.login : e.actor.login
        const cheers = verb === 'merged' ? await celebrateMerge(name, { ...pr, number: n }, actor).catch(err => {
          if (err instanceof RateLimited) throw err
          return [] as string[]
        }) : []
        return { text: [text, ...cheers].join('\n'), log: { kind: verb, actor, item: 'pr', number: n, title: pr.title, url: pr.html_url } }
      }
      case 'PullRequestReviewEvent': {
        const n = p.pull_request?.number
        if (n === undefined || !p.review) return undefined
        const pr = await pull(name, n)
        const state = (p.review.state || '').toLowerCase()
        if (state === 'approved') return { text: `${who} approved PR ${ticket(n, pr.title, p.review.html_url)}` }
        if (state === 'changes_requested') return { text: `${who} requested changes on PR ${ticket(n, pr.title, p.review.html_url)}` }
        return { text: `${who} reviewed PR ${ticket(n, pr.title, p.review.html_url)}: ${esc(truncate(p.review.body || '', 140))}` }
      }
      case 'ReleaseEvent': {
        const r = p.release
        if (!r) return undefined
        const url = r.html_url || `${GH}/${name}/releases/tag/${encodeURIComponent(r.tag_name)}`
        const title = r.name || r.tag_name
        const cheer = releaseCheer({ tag: esc(r.tag_name) }, { tz: defaultTz() })
        return { text: `${who} published release ${link(title, url)}\n${cheer}`, log: { kind: 'release', actor: e.actor.login, title, url } }
      }
      case 'IssueCommentEvent': {
        if (!p.issue || !p.comment) return undefined
        const kind = p.issue.pull_request ? 'PR' : 'issue'
        return { text: `${who} commented on ${kind} ${ticket(p.issue.number, p.issue.title, p.comment.html_url)}: ${esc(truncate(p.comment.body || '', 140))}` }
      }
      case 'PullRequestReviewCommentEvent': {
        const n = p.pull_request?.number
        if (n === undefined || !p.comment) return undefined
        const pr = await pull(name, n)
        return { text: `${who} commented on PR ${ticket(n, pr.title, p.comment.html_url)}: ${esc(truncate(p.comment.body || '', 140))}` }
      }
      default:
        return undefined
    }
  }

  // returns false if the repo was dropped
  const pollEvents = async (key: string, cursor: Cursor, rooms: Record<string, RoomSub>): Promise<number | false> => {
    const res = await call<GhEvent[]>(`/repos/${cursor.name}/events?per_page=100`, cursor.eventsEtag)
    if (res.status === 304) return 0
    if (res.status === 404 || res.status === 410 || res.status === 451) {
      await drop(key, cursor.name, "isn't on GitHub anymore (deleted, renamed or private)")
      return false
    }
    if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`events: GitHub said ${res.status}`)
    if (res.body.some(e => e.public === false)) {
      await drop(key, cursor.name, 'went private')
      return false
    }
    cursor.eventsEtag = res.etag
    if (res.pollInterval) cursor.pollInterval = res.pollInterval
    // ids aren't chronological; remember the whole page instead of a high-water mark
    const seen = new Set(cursor.seenEvents)
    cursor.seenEvents = res.body.map(e => e.id)
    const fresh = res.body
      .filter(e => !seen.has(e.id) && Date.parse(e.created_at) >= cursor.since)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
    let sent = 0
    for (const e of fresh) {
      const cat = categoryOf(e)
      const targets = cat ? roomsFor(rooms, cat) : []
      if (targets.length === 0) continue
      let described: Described | undefined
      try {
        described = await describe(cursor.name, e)
      } catch (err) {
        if (err instanceof RateLimited) throw err
        robot.logger.warn(`github: ${cursor.name}: couldn't describe ${e.type} ${e.id}: ${errorText(err)}`)
      }
      if (!described) continue
      for (const room of targets) {
        await deliver(room, described.text)
        if (described.log) logEvent(robot, 'github', { room, repo: cursor.name, ...described.log })
      }
      sent++
    }
    return sent
  }

  const describeActivity = async (name: string, a: Activity): Promise<string> => {
    const actor = a.actor || { login: 'ghost' }
    const who = `${repoLink(name)} ${userLink(actor)}`
    const branch = branchOf(a.ref)
    if (a.activity_type === 'branch_creation' || ZERO_SHA.test(a.before)) return `${who} pushed new branch ${branchLink(name, branch)} (${commitLink(name, a.after)})`
    if (a.activity_type === 'force_push') return `${who} force-pushed ${branchLink(name, branch)} (${commitLink(name, a.after)})`
    const res = await call<Compare>(`/repos/${name}/compare/${a.before}...${a.after}`)
    return formatPush(name, actor, branch, a.after, res.body)
  }

  const fetchActivity = (cursor: Cursor) =>
    call<Activity[]>(`/repos/${cursor.name}/activity?per_page=100`, cursor.seenActivity ? cursor.activityEtag : undefined)

  // pushes come from /activity; /events can lag by days
  const pollActivity = async (cursor: Cursor, rooms: Record<string, RoomSub>): Promise<number> => {
    const res = await fetchActivity(cursor)
    if (res.status === 304) return 0
    if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`activity: GitHub said ${res.status}`)
    cursor.activityEtag = res.etag
    const seen = new Set(cursor.seenActivity)
    cursor.seenActivity = res.body.map(a => String(a.id))
    const fresh = res.body
      .filter(a => !seen.has(String(a.id)) && Date.parse(a.timestamp) >= cursor.since &&
        ACTIVITY_TYPES.includes(a.activity_type) && a.ref.startsWith('refs/heads/'))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp))
    let sent = 0
    for (const a of fresh) {
      let text: string | undefined
      try {
        text = await describeActivity(cursor.name, a)
      } catch (err) {
        if (err instanceof RateLimited) throw err
        robot.logger.warn(`github: ${cursor.name}: couldn't describe ${a.activity_type} ${a.id}: ${errorText(err)}`)
      }
      if (!text) continue
      // linked accounts, see GithubLink.ts
      const pusher = a.actor ? userForGithubLogin(robot, a.actor.login) : undefined
      // one streak per space
      const milestones = new Map<string, string | undefined>()
      for (const room of roomsFor(rooms, 'pushes')) {
        const space = spaceOf(robot, room)
        if (pusher && !milestones.has(space)) milestones.set(space, recordStreak(robot, space, 'commit', pusher, Date.parse(a.timestamp) || Date.now()))
        const milestone = milestones.get(space)
        await deliver(room, milestone ? `${text}\n${milestone}` : text)
      }
      sent++
    }
    return sent
  }

  const pollRuns = async (cursor: Cursor, rooms: Record<string, RoomSub>): Promise<number> => {
    const res = await call<{ workflow_runs?: Run[] }>(`/repos/${cursor.name}/actions/runs?status=completed&per_page=30`, cursor.runsSeeded ? cursor.runsEtag : undefined)
    if (res.status === 304) return 0
    if (res.status !== 200 || !res.body) throw new Error(`runs: GitHub said ${res.status}`)
    const runs = res.body.workflow_runs || []
    const runKey = (r: Run) => `${r.id}/${r.run_attempt ?? 1}`
    const seen = new Set(cursor.seenRuns)
    const seeding = !cursor.runsSeeded
    cursor.runsEtag = res.etag
    cursor.runsSeeded = true
    cursor.seenRuns = runs.map(runKey)
    let sent = 0
    for (const run of [...runs].sort((a, b) => a.updated_at.localeCompare(b.updated_at))) {
      if (!seeding && seen.has(runKey(run))) continue
      const outcome = run.conclusion === 'success' ? 'success'
        : ['failure', 'timed_out', 'startup_failure'].includes(run.conclusion || '') ? 'failure' : undefined
      if (!outcome) continue
      const k = `${run.workflow_id}@${run.head_branch}`
      const prev = cursor.ciState[k]
      delete cursor.ciState[k]
      cursor.ciState[k] = outcome
      if (seeding) continue
      const fixed = outcome === 'success' && prev === 'failure'
      const text = outcome === 'failure' ? formatRunFailed(cursor.name, run)
        : fixed ? `${formatRunFixed(cursor.name, run)} ${ciCheer({}, { tz: defaultTz() })}` : undefined
      if (!text) continue
      for (const room of roomsFor(rooms, 'ci')) {
        await deliver(room, text)
        if (fixed) logEvent(robot, 'github', { room, repo: cursor.name, kind: 'ci-fixed', actor: run.actor?.login ?? '', title: run.name, url: run.html_url })
      }
      sent++
    }
    const keys = Object.keys(cursor.ciState)
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_CI_KEYS))) delete cursor.ciState[k]
    return sent
  }

  const pollRepo = async (key: string, force: boolean): Promise<number> => {
    const rooms = getSubs()[key]
    if (!rooms) return 0
    const cursor = getCursor(key) || freshCursor(key)
    let sent = 0
    let dropped = false
    try {
      const events = await pollEvents(key, cursor, rooms)
      if (events === false) dropped = true
      else sent += events
      if (!dropped) {
        if (Object.values(rooms).some(r => r.events.includes('pushes'))) {
          sent += await pollActivity(cursor, rooms)
        } else {
          // reseed if pushes come back
          delete cursor.seenActivity
          delete cursor.activityEtag
        }
      }
      if (!dropped && Object.values(rooms).some(r => r.events.includes('ci'))) sent += await pollRuns(cursor, rooms)
      delete cursor.lastError
    } catch (err) {
      cursor.lastError = errorText(err)
      throw err
    } finally {
      if (!dropped && getSubs()[key]) {
        const now = Date.now()
        cursor.idleTicks = sent > 0 || force ? 0 : Math.min(cursor.idleTicks + 1, MAX_IDLE)
        cursor.lastPollAt = now
        if (sent > 0) cursor.lastPostAt = now
        cursor.nextPollAt = now + effectiveSeconds(key, cursor, getSubs()) * 1000
        setCursor(key, cursor)
      }
    }
    return sent
  }

  // one poll per repo at a time; a forced poll joins a running one
  const runPoll = (key: string, force = false): Promise<number> => {
    const running = inflight.get(key)
    if (running) return running
    const p = pollRepo(key, force).finally(() => inflight.delete(key))
    inflight.set(key, p)
    return p
  }

  const tick = async () => {
    if (ticking) return
    ticking = true
    try {
      for (const key of Object.keys(getSubs())) {
        if (Date.now() < rateBlockedUntil) return
        const cursor = getCursor(key)
        if (cursor && Date.now() < cursor.nextPollAt) continue
        await runPoll(key).catch(err => {
          robot.logger.warn(`github: ${key}: ${errorText(err)}`)
        })
      }
    } finally {
      ticking = false
    }
  }

  robot.brain.on('connected', () => {
    if (timer) return
    if (!config().token) robot.logger.warn('github: no GITHUB_TOKEN; polling is limited to 60 requests an hour')
    // a restart shouldn't inherit a long backoff
    const subs = getSubs()
    const now = Date.now()
    for (const key of Object.keys(subs)) {
      const cursor = getCursor(key)
      if (!cursor) continue
      cursor.idleTicks = 0
      cursor.nextPollAt = Math.min(cursor.nextPollAt, now + baseSeconds(key, cursor, subs) * 1000)
      setCursor(key, cursor)
    }
    timer = setInterval(() => { tick() }, TICK_MS)
    timer.unref()
  })
  robot.brain.on('close', () => {
    if (timer) clearInterval(timer)
    timer = undefined
  })

  const rateLimitedReply = (until: number): string => `GitHub's rate limit is used up; try again after ${clockUtc(until)}.`

  const nudgeDays = (): number => Math.max(1, Number(process.env.GITHUB_NUDGE_DAYS) || 2)


  // open, non-draft, old enough, no reviews yet; oldest first
  const waitingPulls = async (name: string): Promise<Pull[]> => {
    const res = await call<Pull[]>(`/repos/${name}/pulls?state=open&sort=created&direction=desc&per_page=30`)
    if (res.status !== 200 || !Array.isArray(res.body)) throw new Error(`pulls: GitHub said ${res.status}`)
    const now = Date.now()
    const candidates = res.body
      .filter(p => {
        const age = now - Date.parse(p.created_at || '')
        return !p.draft && age >= nudgeDays() * DAY_MS && age <= NUDGE_MAX_AGE_MS
      })
      .reverse()
      .slice(0, NUDGE_CHECKS_PER_REPO)
    const waiting: Pull[] = []
    for (const p of candidates) {
      if (waiting.length >= NUDGE_PER_REPO) break
      const reviews = await call<unknown[]>(`/repos/${name}/pulls/${p.number}/reviews?per_page=1`)
      if (reviews.status === 200 && Array.isArray(reviews.body) && reviews.body.length === 0) waiting.push(p)
    }
    return waiting
  }

  const formatWaiting = (name: string, p: Pull, now: number): string => {
    const asked = [...(p.requested_reviewers || []).map(r => r.login), ...(p.requested_teams || []).map(t => t.slug)]
    const by = p.user ? ` by ${userLink(p.user)}` : ''
    const age = formatDuration(now - Date.parse(p.created_at || ''), { units: 1 })
    return `${repoLink(name)} ${ticket(p.number ?? 0, p.title, p.html_url)}${by}, open ${age}${asked.length ? ` (asked: ${esc(asked.join(', '))})` : ''}`
  }

  // room -> message; room limits to one channel and ignores its toggle
  const collectNudges = async (onlyRoom?: string): Promise<Map<string, string>> => {
    const subs = getSubs()
    const cache = new Map<string, Promise<Pull[]>>()
    const lines = new Map<string, string[]>()
    const now = Date.now()
    for (const key of Object.keys(subs).sort()) {
      // async for uncached dms
      const candidates = roomsFor(subs[key] || {}, 'prs')
      const allowed = await Promise.all(candidates.map(r => onlyRoom ? r === onlyRoom : allowsRoomAsync(robot, r, 'github.nudges')))
      const rooms = candidates.filter((_, i) => allowed[i])
      if (rooms.length === 0 || now < rateBlockedUntil) continue
      const name = getCursor(key)?.name || key
      if (!cache.has(key)) cache.set(key, waitingPulls(name))
      let pulls: Pull[]
      try {
        pulls = await cache.get(key)!
      } catch (err) {
        if (err instanceof RateLimited) break
        robot.logger.warn(`github: ${name}: couldn't check reviews: ${errorText(err)}`)
        continue
      }
      for (const room of rooms) {
        const list = lines.get(room) ?? []
        list.push(...pulls.map(p => formatWaiting(name, p, now)))
        lines.set(room, list)
      }
    }
    const out = new Map<string, string>()
    for (const [room, list] of lines) {
      if (list.length) out.set(room, [nudgeIntro({}, { room, tz: defaultTz() }), ...list].join('\n'))
    }
    return out
  }

  const nudgeJobs = scheduler<null>(robot, 'github-nudge', async () => {
    for (const [room, text] of await collectNudges()) await deliver(room, text)
  })

  // after the scheduler re-arms, so a stored job isn't replaced
  robot.brain.on('connected', () => {
    const tz = defaultTz()
    if (nudgeJobs.get('daily')?.tz === tz) return
    nudgeJobs.add({ id: 'daily', at: nextOccurrence(NUDGE_REPEAT, tz, Date.now()), tz, repeat: NUDGE_REPEAT, data: null })
  })

  robot.respond(/github nudge$/i, { id: 'github.nudge' }, async res => {
    const room = res.message.room
    const subs = getSubs()
    if (!Object.values(subs).some(rooms => rooms[room]?.events.includes('prs'))) {
      await res.send(`This channel doesn't follow any repo's PRs. Try \`${robot.name} github subscribe owner/repo prs\`.`)
      return
    }
    if (Date.now() < rateBlockedUntil) {
      await res.send(rateLimitedReply(rateBlockedUntil))
      return
    }
    const text = (await collectNudges(room)).get(room)
    if (text) await deliver(room, text)
    else await res.send(nudgeClear({ days: count(nudgeDays(), 'day') }, { room, tz: defaultTz() }))
  })

  robot.respond(/github digest(?: (week|month))?$/i, { id: 'github.digest' }, async res => {
    const period = (res.match[1] || 'week').toLowerCase()
    const entries = eventsSince<GithubLog>(robot, 'github', Date.now() - (DIGEST_SPANS[period] ?? 7 * DAY_MS), res.message.room)
    await deliver(res.message.room, formatDigest(entries, period))
  })

  robot.respond(/github$/i, { id: 'github.help' }, async res => {
    await res.send([
      `\`${robot.name} github subscribe owner/repo [${CATEGORIES.join('|')}|all] [every 5m]\``,
      `\`${robot.name} github unsubscribe owner/repo [categories]\``,
      `\`${robot.name} github subscriptions\``,
      `\`${robot.name} github poll [owner/repo]\``,
      `\`${robot.name} github digest [week|month]\``,
      `\`${robot.name} github nudge\``,
      `\`${robot.name} github nudges [on|off]\``
    ].join('\n'))
  })

  robot.respond(/github subscribe\s+(\S+)(.*)$/i, { id: 'github.subscribe' }, async res => {
    const room = res.message.room
    const repo = parseRepo(required(res.match, 1))
    if (!repo) {
      await res.send('Give me a repo like `owner/repo` or a github.com link.')
      return
    }
    const opts = parseOptions(res.match[2] || '')
    if (opts.error) {
      await res.send(opts.error)
      return
    }
    let meta: GithubResponse<RepoMeta>
    try {
      meta = await call<RepoMeta>(`/repos/${repo}`)
    } catch (err) {
      await res.send(err instanceof RateLimited ? rateLimitedReply(err.until) : `Couldn't reach GitHub: ${esc(errorText(err))}`)
      return
    }
    if (meta.status === 404) {
      await res.send(`I can't find ${esc(repo)} on GitHub. I only follow public repos.`)
      return
    }
    if (meta.status !== 200 || !meta.body) {
      await res.send(`GitHub said ${meta.status} about ${esc(repo)}; try again later.`)
      return
    }
    const { full_name: name } = meta.body
    if (meta.body.private) {
      await res.send(`${esc(name)} is private; I only follow public repos.`)
      return
    }
    if (meta.body.archived) {
      await res.send(`${esc(name)} is archived, so nothing will happen there.`)
      return
    }

    const key = name.toLowerCase()
    const subs = getSubs()
    const rooms = subs[key] || {}
    const existing = rooms[room]
    const wanted = opts.categories.length ? opts.categories : DEFAULT_CATEGORIES
    const events = CATEGORIES.filter(c => wanted.includes(c) || existing?.events.includes(c))
    const interval = opts.interval ?? existing?.interval
    rooms[room] = { events, ...(interval ? { interval } : {}), by: res.message.user.name, at: Date.now() }
    subs[key] = rooms
    setSubs(subs)

    let cursor = getCursor(key)
    if (!cursor) {
      cursor = freshCursor(name)
      try {
        const seed = await call<GhEvent[]>(`/repos/${name}/events?per_page=100`)
        if (seed.status === 200 && Array.isArray(seed.body)) {
          cursor.seenEvents = seed.body.map(e => e.id)
          cursor.eventsEtag = seed.etag
          if (seed.pollInterval) cursor.pollInterval = seed.pollInterval
        }
      } catch (err) {
        robot.logger.warn(`github: ${name}: couldn't seed events: ${errorText(err)}`)
      }
    }
    cursor.name = name
    if (events.includes('pushes') && !cursor.seenActivity) {
      try {
        const seed = await fetchActivity(cursor)
        if (seed.status === 200 && Array.isArray(seed.body)) {
          cursor.seenActivity = seed.body.map(a => String(a.id))
          cursor.activityEtag = seed.etag
        }
      } catch (err) {
        robot.logger.warn(`github: ${name}: couldn't seed activity: ${errorText(err)}`)
      }
    }
    if (events.includes('ci') && !cursor.runsSeeded) {
      await pollRuns(cursor, rooms).catch(err => robot.logger.warn(`github: ${name}: couldn't seed runs: ${errorText(err)}`))
    }
    cursor.idleTicks = 0
    const now = Date.now()
    const base = baseSeconds(key, cursor, getSubs())
    cursor.nextPollAt = cursor.nextPollAt > now ? Math.min(cursor.nextPollAt, now + base * 1000) : now + base * 1000
    setCursor(key, cursor)

    await res.send(`Following ${repoLink(name)} here: ${events.join(', ')} (checking every ${formatDuration(base * 1000)}). \`${robot.name} github poll\` checks right away.`)
  })

  robot.respond(/github unsubscribe\s+(\S+)(.*)$/i, { id: 'github.unsubscribe' }, async res => {
    const room = res.message.room
    const repo = parseRepo(required(res.match, 1))
    if (!repo) {
      await res.send('Give me a repo like `owner/repo` or a github.com link.')
      return
    }
    const opts = parseOptions(res.match[2] || '')
    if (opts.error) {
      await res.send(opts.error)
      return
    }
    const key = repo.toLowerCase()
    const subs = getSubs()
    const rooms = subs[key]
    const sub = rooms?.[room]
    if (!rooms || !sub) {
      await res.send(`This channel doesn't follow ${esc(repo)}.`)
      return
    }
    const name = getCursor(key)?.name || repo
    const remaining = opts.categories.length ? sub.events.filter(c => !opts.categories.includes(c)) : []
    if (remaining.length) {
      rooms[room] = { ...sub, events: remaining }
    } else {
      delete rooms[room]
    }
    if (Object.keys(rooms).length) {
      subs[key] = rooms
    } else {
      delete subs[key]
      robot.brain.remove(CURSOR_PREFIX + key)
    }
    setSubs(subs)
    await res.send(remaining.length
      ? `Still following ${repoLink(name)} here, now just: ${remaining.join(', ')}.`
      : `Stopped following ${repoLink(name)} here.`)
  })

  const repoStats = (key: string, sub: RoomSub, subs: Subs): RepoStats => {
    const cursor = getCursor(key) || freshCursor(key)
    const base = baseSeconds(key, cursor, subs)
    return {
      ...cursor,
      events: sub.events,
      base,
      every: effectiveSeconds(key, cursor, subs),
      max: Math.max(config().maxSec, base)
    }
  }

  robot.respond(/github (?:subscriptions|subs|list|status)$/i, { id: 'github.subs' }, async res => {
    const room = res.message.room
    const subs = getSubs()
    const now = Date.now()
    const blocks = Object.keys(subs).sort().flatMap(key => {
      const sub = subs[key]?.[room]
      return sub ? [formatRepoStatus(repoStats(key, sub, subs), now)] : []
    })
    await res.send(blocks.length
      ? [...blocks, formatApiStatus({ authed: Boolean(config().token), rate, pausedUntil: rateBlockedUntil }, now)].join('\n\n')
      : `This channel doesn't follow any repos. Try \`${robot.name} github subscribe owner/repo\`.`)
  })

  robot.respond(/github poll(?:\s+(\S+))?$/i, { id: 'github.poll' }, async res => {
    const room = res.message.room
    const subs = getSubs()
    let keys = Object.keys(subs).filter(key => subs[key]?.[room])
    if (res.match[1]) {
      const repo = parseRepo(res.match[1])
      const key = repo?.toLowerCase()
      if (!key || !keys.includes(key)) {
        await res.send(`This channel doesn't follow ${esc(repo || res.match[1])}.`)
        return
      }
      keys = [key]
    }
    if (keys.length === 0) {
      await res.send(`This channel doesn't follow any repos. Try \`${robot.name} github subscribe owner/repo\`.`)
      return
    }
    if (Date.now() < rateBlockedUntil) {
      await res.send(rateLimitedReply(rateBlockedUntil))
      return
    }
    let sent = 0
    let polled = 0
    const failures: string[] = []
    for (const key of keys) {
      const cursor = getCursor(key)
      if (cursor && Date.now() - cursor.lastPollAt < FORCE_GUARD_MS && !inflight.has(key)) continue
      polled++
      try {
        sent += await runPoll(key, true)
      } catch (err) {
        if (err instanceof RateLimited) {
          await res.send(rateLimitedReply(err.until))
          return
        }
        failures.push(`Couldn't check ${esc(cursor?.name || key)}: ${esc(errorText(err))}`)
      }
    }
    if (failures.length) await res.send(failures.join('\n'))
    else if (polled === 0) await res.send('I just checked; give it a few seconds.')
    else if (sent === 0) await res.send('Nothing new.')
  })
}
