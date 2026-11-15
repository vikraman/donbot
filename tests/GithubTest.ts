import { describe, it, beforeEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

import type { DiscordClient, Envelope } from 'hubot'

import * as Github from '../scripts/Github.ts'
import type { Activity, GhEvent, Run } from '../scripts/Github.ts'
import { parseRepo } from '../scripts/lib/github.ts'
import { setupRobot, brainUser } from './helpers/setup.ts'
import type { TestRobot } from './helpers/setup.ts'

const ENV = ['GITHUB_TOKEN', 'GITHUB_POLL_SECONDS', 'GITHUB_POLL_MAX_SECONDS']
const START = Date.parse('2026-11-15T12:00:00Z')
const TICK = 15_000

const flush = async () => {
  for (let i = 0; i < 30; i++) await new Promise(resolve => setImmediate(resolve))
}

interface Sent { room: string, text: string }
interface Call { path: string, headers: Record<string, string> }

interface RepoState {
  meta: { full_name: string, private: boolean, archived: boolean }
  events: GhEvent[]
  activity: Activity[]
  runs: Run[]
  pulls: Record<number, { title: string, html_url: string, merged?: boolean }>
  compares: Record<string, unknown>
  status?: number
}

// fake api.github.com keyed by lowercased owner/repo; real etags so 304s happen
const fakeGithub = () => {
  const repos: Record<string, RepoState> = {}
  const calls: Call[] = []
  const add = (name: string, extra: Partial<RepoState['meta']> = {}): RepoState => {
    const repo: RepoState = { meta: { full_name: name, private: false, archived: false, ...extra }, events: [], activity: [], runs: [], pulls: {}, compares: {} }
    repos[name.toLowerCase()] = repo
    return repo
  }
  const reply = (body: unknown, ifNoneMatch?: string, extra: Record<string, string> = {}) => {
    const json = JSON.stringify(body)
    const etag = `"${createHash('md5').update(json).digest('hex')}"`
    const headers = { 'etag': etag, 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4999', 'x-ratelimit-reset': String(START / 1000 + 3600), ...extra }
    if (ifNoneMatch === etag) return new Response(null, { status: 304, headers })
    return new Response(json, { status: 200, headers })
  }
  mock.method(global, 'fetch', async (url: string, init: RequestInit) => {
    const u = new URL(url)
    const headers = (init.headers || {}) as Record<string, string>
    calls.push({ path: u.pathname + u.search, headers })
    const m = u.pathname.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/)
    const repo = m && repos[(m[1] || '').toLowerCase()]
    if (!m || !repo) return new Response('{"message":"Not Found"}', { status: 404 })
    if (repo.status) return new Response('{}', { status: repo.status })
    const rest = m[2] || ''
    const etag = headers['If-None-Match']
    if (rest === '') return reply(repo.meta)
    if (rest === '/events') return reply([...repo.events].reverse(), etag, { 'x-poll-interval': '60' })
    if (rest === '/activity') return reply([...repo.activity].reverse(), etag)
    if (rest === '/actions/runs') return reply({ total_count: repo.runs.length, workflow_runs: [...repo.runs].reverse() }, etag)
    const pr = rest.match(/^\/pulls\/(\d+)$/)
    if (pr && repo.pulls[Number(pr[1])]) return reply(repo.pulls[Number(pr[1])])
    const cmp = rest.match(/^\/compare\/(.+)$/)
    if (cmp && repo.compares[cmp[1] as string]) return reply(repo.compares[cmp[1] as string])
    return new Response('{"message":"Not Found"}', { status: 404 })
  })
  return { repos, calls, add }
}

let seq = 1000
const ev = (type: string, payload: GhEvent['payload'], at = '2026-11-15T12:00:30Z', login = 'alice'): GhEvent =>
  ({ id: String(++seq), type, created_at: at, public: true, actor: { login, display_login: login }, payload })

const issue = (n: number, title: string, action = 'opened') =>
  ev('IssuesEvent', { action, issue: { number: n, title, html_url: `https://github.com/Octo/Demo/issues/${n}` } })

let actSeq = 90000
const act = (activity_type: string, before: string, after: string, ref = 'refs/heads/main', at = '2026-11-15T12:00:30Z', login = 'alice'): Activity =>
  ({ id: ++actSeq, activity_type, before, after, ref, timestamp: at, actor: { login } })

let runSeq = 500
const run = (conclusion: string, name = 'build', branch = 'main', at = '2026-11-15T12:00:40Z'): Run =>
  ({ id: ++runSeq, run_attempt: 1, name, workflow_id: name === 'build' ? 1 : 2, head_branch: branch, head_sha: 'abcdef1234567890', conclusion, html_url: `https://github.com/Octo/Demo/actions/runs/${runSeq}`, updated_at: at })

// every url sits inside (<...>), so discord shows no previews
const assertNoBareUrls = (text: string) => {
  assert.doesNotMatch(text, /(?<!\(<)https?:\/\//, text)
  assert.doesNotMatch(text, /\]\((?!<)/, text)
}

describe('Github helpers', () => {
  it('parses repos and links', () => {
    assert.strictEqual(parseRepo('octo/demo'), 'octo/demo')
    assert.strictEqual(parseRepo('https://github.com/Octo/Demo'), 'Octo/Demo')
    assert.strictEqual(parseRepo('<https://github.com/octo/demo.git>'), 'octo/demo')
    assert.strictEqual(parseRepo('github.com/octo/demo/pull/3'), 'octo/demo')
    assert.strictEqual(parseRepo('octo'), undefined)
    assert.strictEqual(parseRepo('https://example.com/octo/demo'), undefined)
  })

  it('parses categories and intervals', () => {
    assert.deepStrictEqual(Github.parseOptions(''), { categories: [], interval: undefined })
    assert.deepStrictEqual(Github.parseOptions(' pr, commits CI'), { categories: ['prs', 'pushes', 'ci'], interval: undefined })
    assert.deepStrictEqual(Github.parseOptions('all every 5m').categories.length, 6)
    assert.strictEqual(Github.parseOptions('issues every 5m').interval, 300)
    assert.strictEqual(Github.parseOptions('every 2 hours').error !== undefined, true)
    assert.strictEqual(Github.parseOptions('every 90 s').interval, 90)
    assert.strictEqual(Github.parseOptions('every 10').interval, 600)
    assert.match(Github.parseOptions('every 30s').error || '', /between 1m and 1h/)
    assert.match(Github.parseOptions('stars').error || '', /don't know "stars"/)
  })

  it('escapes link text so titles cannot break out', () => {
    assert.strictEqual(Github.link('a](x) @everyone', 'https://github.com/o/r'), '[a\\]\\(x\\) @​everyone](<https://github.com/o/r>)')
    assert.strictEqual(Github.esc('`code` *b*\nnext'), '\\`code\\` \\*b\\* next')
    assert.strictEqual(Github.link('t', 'https://github.com/o/r/tree/a>b'), '[t](<https://github.com/o/r/tree/a%3Eb>)')
    assert.strictEqual(Github.esc('see https://x.io/a and HTTP://y.io'), 'see https\\://x.io/a and HTTP\\://y.io')
  })

  it('formats repo and api status', () => {
    const stats: Github.RepoStats = { name: 'Octo/Demo', events: ['issues', 'pushes'], base: 60, every: 960, max: 3600, idleTicks: 4, lastPollAt: START - 180_000, nextPollAt: START + 780_000 }
    assert.strictEqual(Github.formatRepoStatus(stats, START), [
      '**[Octo/Demo](<https://github.com/Octo/Demo>)**: issues, pushes',
      'Polling: every 16m, backed off from 1m after 4 quiet polls (max 1h)',
      'Last poll: 3m ago (ok), next in 13m, last post never'
    ].join('\n'))
    const fresh = Github.formatRepoStatus({ ...stats, every: 60, idleTicks: 0, lastPollAt: 0, nextPollAt: START - 1 }, START)
    assert.match(fresh, /\nPolling: every 1m\nLast poll: never, next now, last post never$/)
    const failed = Github.formatRepoStatus({ ...stats, lastError: 'events: GitHub said `502`', lastPostAt: START - 7_200_000 }, START)
    assert.match(failed, /\nLast poll: 3m ago \(failed: events: GitHub said \\`502\\`\), next in 13m, last post 2h ago$/)
    assertNoBareUrls(failed)
    assert.strictEqual(Github.formatApiStatus({ authed: false, pausedUntil: 0 }, START), 'GitHub API: no token')
    const rate = { remaining: 2, limit: 5000, reset: START + 3_600_000 }
    assert.strictEqual(Github.formatApiStatus({ authed: true, rate, pausedUntil: rate.reset }, START), 'GitHub API: token, 2/5000 requests left, resets 13:00 UTC, paused until 13:00 UTC')
  })

  it('formats durations', () => {
    assert.strictEqual(Github.formatDuration(60), '1m')
    assert.strictEqual(Github.formatDuration(3600), '1h')
    assert.strictEqual(Github.formatDuration(5400), '1h30m')
  })

  it('maps events to categories', () => {
    assert.strictEqual(Github.categoryOf(issue(1, 't')), 'issues')
    assert.strictEqual(Github.categoryOf(issue(1, 't', 'labeled')), undefined)
    // pushes come from /activity
    assert.strictEqual(Github.categoryOf(ev('PushEvent', {})), undefined)
    assert.strictEqual(Github.categoryOf(ev('PullRequestReviewEvent', { action: 'created', review: { state: 'approved', html_url: 'x' }, pull_request: { number: 1 } })), 'prs')
    assert.strictEqual(Github.categoryOf(ev('PullRequestReviewEvent', { action: 'updated', review: { state: 'approved', html_url: 'x' }, pull_request: { number: 1 } })), undefined)
    assert.strictEqual(Github.categoryOf(ev('PullRequestReviewEvent', { action: 'created', review: { state: 'commented', html_url: 'x', body: '' }, pull_request: { number: 1 } })), undefined)
    assert.strictEqual(Github.categoryOf(ev('WatchEvent', { action: 'started' })), undefined)
  })

  it('formats pushes and ci with only wrapped links', () => {
    const actor = { login: 'renovate[bot]', display_login: 'renovate' }
    const commits = ['one', 'two', 'three', 'four'].map((msg, i) => ({ sha: `${i}`.repeat(40), html_url: '', commit: { message: `${msg}\n\nbody` } }))
    const text = Github.formatPush('Octo/Demo', actor, 'feat/x', 'f'.repeat(40), { status: 'ahead', total_commits: 5, html_url: 'https://github.com/Octo/Demo/compare/a...b', commits })
    assert.match(text, /\[renovate\]\(<https:\/\/github\.com\/apps\/renovate>\) pushed \[5 commits\]/)
    assert.match(text, /to \[feat\/x\]\(<https:\/\/github\.com\/Octo\/Demo\/tree\/feat\/x>\)/)
    assert.doesNotMatch(text, /one/)
    assert.match(text, /\[`1111111`\]|\[\\`1111111\\`\]|\[1111111\]/)
    assert.match(text, /four\n…and 2 more$/)
    assertNoBareUrls(text)
    const forced = Github.formatPush('Octo/Demo', actor, 'main', 'f'.repeat(40), { status: 'diverged', total_commits: 1, html_url: '', commits: [] })
    assert.match(forced, /force-pushed/)
    const failed = Github.formatRunFailed('Octo/Demo', run('timed_out'))
    assert.match(failed, /❌ CI \[build\]\(<.+>\) timed out on \[main\]/)
    assertNoBareUrls(failed)
  })
})

describe('Github testing Hubot scripts', () => {
  const state = setupRobot(['Github.ts', 'Roles.ts'], { envVars: ENV })
  let now: number
  let gh: ReturnType<typeof fakeGithub>
  let sent: Sent[]
  let tickFn: (() => void) | undefined

  beforeEach(() => {
    now = START
    mock.method(Date, 'now', () => now)
    // mock.timers would also swallow the brain's clearInterval on shutdown
    tickFn = undefined
    mock.method(global, 'setInterval', (fn: () => void) => {
      tickFn = fn
      return { unref: () => {} }
    })
    process.env.GITHUB_TOKEN = 'tok'
    delete process.env.GITHUB_POLL_SECONDS
    delete process.env.GITHUB_POLL_MAX_SECONDS
    gh = fakeGithub()
    sent = []
    state.robot.on('send', (envelope: Envelope, ...strings: string[]) => {
      sent.push({ room: envelope.room || '', text: strings.join('') })
    })
    state.robot.brain.emit('connected')
  })

  const say = async (robot: TestRobot, text: string, room = 'room-a') => {
    await robot.adapter.say(brainUser(robot, 'u1', 'alice'), `@Dumbotheelephant ${text}`, room)
    await flush()
  }

  const advance = async (ms: number) => {
    for (let t = 0; t < ms; t += TICK) {
      now += TICK
      tickFn?.()
      await flush()
    }
  }

  const take = (): Sent[] => sent.splice(0)
  const texts = (room?: string): string[] => take().filter(s => !room || s.room === room).map(s => s.text)

  it('subscribes with the default categories and posts no backlog', async () => {
    const repo = gh.add('Octo/Demo')
    repo.events.push(ev('IssuesEvent', { action: 'opened', issue: { number: 1, title: 'old', html_url: 'u' } }, '2026-11-15T11:00:00Z'))
    await say(state.robot, 'github subscribe octo/demo')
    const [reply] = texts()
    assert.match(reply || '', /Following \*\*\[Octo\/Demo\]\(<https:\/\/github\.com\/Octo\/Demo>\)\*\* here: issues, prs, pushes, ci, releases \(checking every 1m\)/)
    await advance(60_000)
    assert.deepStrictEqual(texts(), [])
  })

  it('accepts a github url and merges categories on re-subscribe', async () => {
    gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe https://github.com/octo/demo issues')
    await say(state.robot, 'github subscribe octo/demo ci every 5m')
    take()
    await say(state.robot, 'github subscriptions')
    assert.deepStrictEqual(texts(), [[
      '**[Octo/Demo](<https://github.com/Octo/Demo>)**: issues, ci',
      'Polling: every 5m',
      'Last poll: never, next in 1m, last post never',
      '',
      'GitHub API: token, 4999/5000 requests left, resets 13:00 UTC'
    ].join('\n')])
  })

  it('rejects missing, private and archived repos and bad input', async () => {
    gh.add('Octo/Secret', { private: true })
    gh.add('Octo/Old', { archived: true })
    await say(state.robot, 'github subscribe octo/nope')
    await say(state.robot, 'github subscribe octo/secret')
    await say(state.robot, 'github subscribe octo/old')
    await say(state.robot, 'github subscribe nope')
    await say(state.robot, 'github subscribe octo/old stars')
    await say(state.robot, 'github subscribe octo/old every 10s')
    const out = texts()
    assert.match(out[0] || '', /can't find octo\/nope/)
    assert.match(out[1] || '', /Octo\/Secret is private/)
    assert.match(out[2] || '', /Octo\/Old is archived/)
    assert.match(out[3] || '', /owner\/repo/)
    assert.match(out[4] || '', /don't know "stars"/)
    assert.match(out[5] || '', /between 1m and 1h/)
    assert.strictEqual(out.length, 6)
    assert.deepStrictEqual(state.robot.brain.get('github:subs') ?? {}, {})
  })

  it('does not trip sibling listeners', async () => {
    gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues')
    await say(state.robot, 'github poll')
    await say(state.robot, 'github unsubscribe octo/demo')
    assert.strictEqual(texts().length, 3)
  })

  it('unsubscribes some or all categories', async () => {
    gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo')
    await say(state.robot, 'github unsubscribe octo/demo ci pushes')
    await say(state.robot, 'github unsubscribe octo/demo')
    await say(state.robot, 'github unsubscribe octo/demo')
    await say(state.robot, 'github subscriptions')
    const out = texts()
    assert.match(out[1] || '', /now just: issues, prs, releases/)
    assert.match(out[2] || '', /Stopped following/)
    assert.match(out[3] || '', /doesn't follow octo\/demo/)
    assert.match(out[4] || '', /doesn't follow any repos/)
    assert.strictEqual(state.robot.brain.get('github:cursor:octo/demo') ?? undefined, undefined)
  })

  it('routes new events to the rooms that want them', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues', 'room-a')
    await say(state.robot, 'github subscribe octo/demo prs', 'room-b')
    take()
    repo.events.push(issue(7, 'Login [broken]'))
    repo.events.push(ev('PullRequestEvent', { action: 'closed', number: 9, pull_request: { number: 9 } }, '2026-11-15T12:00:35Z', 'bob'))
    repo.events.push(ev('WatchEvent', { action: 'started' }))
    repo.pulls[9] = { title: 'Add thing', html_url: 'https://github.com/Octo/Demo/pull/9', merged: true }
    await advance(60_000)
    const out = take()
    assert.deepStrictEqual(out.map(s => s.room), ['room-a', 'room-b'])
    assert.strictEqual(out[0]?.text, '**[Octo/Demo](<https://github.com/Octo/Demo>)** [alice](<https://github.com/alice>) opened issue [#7 Login \\[broken\\]](<https://github.com/Octo/Demo/issues/7>)')
    assert.strictEqual(out[1]?.text, '**[Octo/Demo](<https://github.com/Octo/Demo>)** [bob](<https://github.com/bob>) merged PR [#9 Add thing](<https://github.com/Octo/Demo/pull/9>)')
    out.forEach(s => assertNoBareUrls(s.text))
  })

  it('sends the etag and posts nothing on 304', async () => {
    gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo')
    take()
    await advance(60_000)
    const polls = gh.calls.filter(c => c.path.includes('/events'))
    assert.ok(polls.length >= 2)
    assert.ok(polls.at(-1)?.headers['If-None-Match'])
    assert.strictEqual(polls.at(-1)?.headers.Authorization, 'Bearer tok')
    assert.deepStrictEqual(texts(), [])
  })

  it('looks up commits for pushes', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo pushes')
    take()
    repo.activity.push(act('push', 'a'.repeat(40), 'b'.repeat(40)))
    repo.compares[`${'a'.repeat(40)}...${'b'.repeat(40)}`] = {
      status: 'ahead', total_commits: 1, html_url: 'https://github.com/Octo/Demo/compare/x...y',
      commits: [{ sha: 'b'.repeat(40), html_url: '', commit: { message: 'fix the thing\n\ndetails' } }]
    }
    await advance(60_000)
    const [text] = texts()
    assert.strictEqual(text, [
      '**[Octo/Demo](<https://github.com/Octo/Demo>)** [alice](<https://github.com/alice>) pushed [1 commit](<https://github.com/Octo/Demo/compare/x...y>) to [main](<https://github.com/Octo/Demo/tree/main>)',
      `[bbbbbbb](<https://github.com/Octo/Demo/commit/${'b'.repeat(40)}>) fix the thing`
    ].join('\n'))
  })

  it('posts force pushes, new branches and merges, but not deletions, tags or push events', async () => {
    const repo = gh.add('Octo/Demo')
    repo.activity.push(act('push', 'c'.repeat(40), 'd'.repeat(40), 'refs/heads/main', '2026-11-15T11:59:00Z'))
    await say(state.robot, 'github subscribe octo/demo pushes')
    take()
    const zero = '0'.repeat(40)
    repo.activity.push(act('force_push', 'a'.repeat(40), 'b'.repeat(40), 'refs/heads/feat', '2026-11-15T12:00:31Z', 'bob'))
    repo.activity.push(act('branch_creation', zero, 'e'.repeat(40), 'refs/heads/new', '2026-11-15T12:00:30Z'))
    repo.activity.push(act('branch_deletion', 'e'.repeat(40), zero, 'refs/heads/old'))
    repo.activity.push(act('push', zero, 'f'.repeat(40), 'refs/tags/v1'))
    repo.activity.push(act('pr_merge', 'a'.repeat(40), 'f'.repeat(40), 'refs/heads/main', '2026-11-15T12:00:32Z'))
    repo.events.push(ev('PushEvent', { ref: 'refs/heads/main', before: 'a'.repeat(40), head: 'f'.repeat(40) } as GhEvent['payload']))
    await advance(60_000)
    const out = texts()
    assert.strictEqual(out.length, 3)
    assert.match(out[0] || '', /\[alice\].* pushed new branch \[new\]/)
    assert.match(out[1] || '', /\[bob\].* force-pushed \[feat\]\(<https:\/\/github\.com\/Octo\/Demo\/tree\/feat>\) \(\[bbbbbbb\]/)
    assert.match(out[2] || '', /\[alice\].* pushed to \[main\].*\(\[fffffff\]/)
    out.forEach(assertNoBareUrls)
  })

  it('only polls activity for push subscribers and sends its etag', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues')
    await advance(60_000)
    assert.ok(gh.calls.every(c => !c.path.includes('/activity')))
    await say(state.robot, 'github subscribe octo/demo pushes')
    take()
    await advance(60_000)
    const polls = gh.calls.filter(c => c.path.includes('/activity'))
    assert.ok(polls.length >= 2)
    assert.ok(polls.at(-1)?.headers['If-None-Match'])
    repo.activity.push(act('force_push', 'a'.repeat(40), 'b'.repeat(40), 'refs/heads/main', '2026-11-15T12:01:50Z'))
    now += 16_000
    await say(state.robot, 'github poll')
    assert.match(texts()[0] || '', /force-pushed/)
  })

  it('catches up on pushes since the subscription for cursors without activity', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues pushes')
    take()
    const cursor = state.robot.brain.get('github:cursor:octo/demo') as Record<string, unknown>
    delete cursor.seenActivity
    delete cursor.activityEtag
    repo.activity.push(act('force_push', 'a'.repeat(40), 'b'.repeat(40), 'refs/heads/main', '2026-11-15T11:00:00Z'))
    repo.activity.push(act('force_push', 'a'.repeat(40), 'c'.repeat(40), 'refs/heads/main', '2026-11-15T12:00:10Z'))
    await advance(60_000)
    const out = texts()
    assert.strictEqual(out.length, 1)
    assert.match(out[0] || '', /ccccccc/)
  })

  it('reports ci failures and recoveries but not routine greens', async () => {
    const repo = gh.add('Octo/Demo')
    repo.runs.push(run('success', 'build', 'main', '2026-11-15T11:00:00Z'))
    await say(state.robot, 'github subscribe octo/demo ci')
    take()
    repo.runs.push(run('failure'))
    repo.runs.push(run('cancelled', 'lint'))
    await say(state.robot, 'github poll')
    assert.match(texts()[0] || '', /❌ CI \[build\]\(<https:\/\/github\.com\/Octo\/Demo\/actions\/runs\/\d+>\) failed on \[main\]/)
    now += 20_000
    repo.runs.push(run('success', 'build', 'main', '2026-11-15T12:01:00Z'))
    await say(state.robot, 'github poll')
    assert.match(texts()[0] || '', /✅ CI \[build\].* is passing again on \[main\]/)
    now += 20_000
    repo.runs.push(run('success', 'build', 'main', '2026-11-15T12:02:00Z'))
    await say(state.robot, 'github poll')
    assert.deepStrictEqual(texts(), ['Nothing new.'])
  })

  it('honours per-subscription intervals, lowest wins', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues every 5m', 'room-a')
    take()
    repo.events.push(issue(1, 'one'))
    await advance(4 * 60_000)
    assert.deepStrictEqual(texts(), [])
    await advance(60_000)
    assert.strictEqual(texts().length, 1)
    await say(state.robot, 'github subscribe octo/demo issues every 2m', 'room-b')
    await say(state.robot, 'github subscriptions', 'room-a')
    assert.match(texts('room-a')[0] || '', /every 2m/)
  })

  it('backs off while quiet and snaps back on activity', async () => {
    const repo = gh.add('Octo/Demo')
    process.env.GITHUB_POLL_MAX_SECONDS = '600'
    await say(state.robot, 'github subscribe octo/demo issues')
    take()
    // quiet polls at 1m, 3m, 7m, 15m; 16m caps to 10m
    await advance(7 * 60_000)
    await say(state.robot, 'github subscriptions')
    assert.match(texts()[0] || '', /\nPolling: every 8m, backed off from 1m after 3 quiet polls \(max 10m\)\nLast poll: 0s ago \(ok\), next in 8m, last post never\n/)
    await advance(9 * 60_000)
    await say(state.robot, 'github subscriptions')
    assert.match(texts()[0] || '', /\nPolling: every 10m, backed off from 1m after 4 quiet polls \(max 10m\)\n/)
    repo.events.push(ev('IssuesEvent', { action: 'opened', issue: { number: 2, title: 't', html_url: 'u' } }, '2026-11-15T12:20:00Z'))
    // next quiet poll was due at 25m
    await advance(9 * 60_000)
    assert.strictEqual(texts().length, 1)
    await say(state.robot, 'github subscriptions')
    assert.match(texts()[0] || '', /\nPolling: every 1m\nLast poll: 0s ago \(ok\), next in 1m, last post 0s ago\n/)
  })

  it('resets the backoff on restart', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues')
    take()
    // quiet polls at 1m, 3m, 7m, 15m
    await advance(15 * 60_000)
    await say(state.robot, 'github subscriptions')
    assert.match(texts()[0] || '', /\nPolling: every 16m, backed off from 1m after 4 quiet polls/)
    state.robot.brain.emit('close')
    state.robot.brain.emit('connected')
    await say(state.robot, 'github subscriptions')
    assert.match(texts()[0] || '', /\nPolling: every 1m\nLast poll: 0s ago \(ok\), next in 1m,/)
    repo.events.push(issue(8, 'after restart'))
    await advance(60_000)
    assert.match(texts()[0] || '', /opened issue \[#8 after restart\]/)
  })

  it('stretches the interval without a token', async () => {
    delete process.env.GITHUB_TOKEN
    gh.add('Octo/Demo')
    gh.add('Octo/Other')
    await say(state.robot, 'github subscribe octo/demo')
    await say(state.robot, 'github subscribe octo/other')
    take()
    await say(state.robot, 'github subscriptions')
    const out = texts()[0] || ''
    assert.strictEqual(out.match(/\nPolling: every 6m\n/g)?.length, 2)
    assert.match(out, /\n\nGitHub API: no token, /)
    assert.ok(gh.calls.every(c => !('Authorization' in c.headers)))
  })

  it('shows poll failures, last post and the rate limit pause', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo issues')
    repo.events.push(issue(5, 'hello'))
    await advance(60_000)
    take()
    now += 5 * 60_000
    repo.status = 502
    await advance(120_000)
    await say(state.robot, 'github status')
    assert.match(texts()[0] || '', /\nLast poll: 2m ago \(failed: events: GitHub said 502\), next in 15s, last post 7m ago\n/)
    repo.status = undefined
    gh.calls.length = 0
    mock.method(global, 'fetch', async () => new Response('[]', { status: 200, headers: { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '2', 'x-ratelimit-reset': String(START / 1000 + 3600) } }))
    now += 16_000
    await say(state.robot, 'github poll')
    take()
    await say(state.robot, 'github status')
    assert.match(texts()[0] || '', /\n\nGitHub API: token, 2\/5000 requests left, resets 13:00 UTC, paused until 13:00 UTC$/)
  })

  it('polls on demand', async () => {
    const repo = gh.add('Octo/Demo')
    gh.add('Octo/Other')
    await say(state.robot, 'github subscribe octo/demo issues')
    await say(state.robot, 'github poll octo/other')
    await say(state.robot, 'github poll')
    take()
    repo.events.push(issue(3, 'urgent'))
    await say(state.robot, 'github poll')
    assert.deepStrictEqual(texts(), ['I just checked; give it a few seconds.'])
    now += 16_000
    await say(state.robot, 'github poll octo/demo')
    const out = texts()
    assert.strictEqual(out.length, 1)
    assert.match(out[0] || '', /opened issue \[#3 urgent\]/)
  })

  it('reports nothing new and rejects repos the channel does not follow', async () => {
    gh.add('Octo/Demo')
    await say(state.robot, 'github poll')
    await say(state.robot, 'github subscribe octo/demo')
    await say(state.robot, 'github poll octo/elsewhere')
    take()
    now += 16_000
    await say(state.robot, 'github poll')
    assert.deepStrictEqual(texts(), ['Nothing new.'])
  })

  it('drops a repo that disappears', async () => {
    const repo = gh.add('Octo/Demo')
    await say(state.robot, 'github subscribe octo/demo', 'room-a')
    await say(state.robot, 'github subscribe octo/demo issues', 'room-b')
    take()
    repo.status = 404
    await advance(60_000)
    const out = take()
    assert.deepStrictEqual(out.map(s => s.room).sort(), ['room-a', 'room-b'])
    assert.match(out[0]?.text || '', /isn't on GitHub anymore .* stopped following it here/)
    assert.deepStrictEqual(state.robot.brain.get('github:subs'), {})
    await advance(120_000)
    assert.deepStrictEqual(take(), [])
  })

  it('posts through discord with previews suppressed and pings off', async () => {
    const repo = gh.add('Octo/Demo')
    const channelSend = mock.fn(async (_payload: unknown) => ({}))
    state.robot.adapter.client = { channels: { cache: new Map([['room-a', { send: channelSend }]]) } } as unknown as DiscordClient
    await say(state.robot, 'github subscribe octo/demo issues')
    take()
    repo.events.push(issue(4, '@everyone look'))
    await advance(60_000)
    assert.strictEqual(channelSend.mock.callCount(), 1)
    const payload = channelSend.mock.calls[0]?.arguments[0] as { content: string, flags: number, allowedMentions: unknown }
    assert.strictEqual(payload.flags, 4)
    assert.deepStrictEqual(payload.allowedMentions, { parse: [] })
    assert.match(payload.content, /@​everyone look/)
    assertNoBareUrls(payload.content)
  })
})
