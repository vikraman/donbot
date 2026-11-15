const API = 'https://api.github.com'

export interface GithubResponse<T> {
  status: number
  etag?: string
  pollInterval?: number
  rateLimit?: number
  rateRemaining?: number
  rateReset?: number
  body?: T
}

export interface GithubClient {
  authed: boolean
  get: <T>(path: string, etag?: string) => Promise<GithubResponse<T>>
}

const num = (value: string | null): number | undefined => {
  const n = value === null ? NaN : Number(value)
  return Number.isFinite(n) ? n : undefined
}

export const githubClient = (token?: string): GithubClient => ({
  authed: Boolean(token),
  get: async <T>(path: string, etag?: string): Promise<GithubResponse<T>> => {
    const headers: Record<string, string> = {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'donbot',
      'X-GitHub-Api-Version': '2022-11-28'
    }
    if (token) headers.Authorization = `Bearer ${token}`
    if (etag) headers['If-None-Match'] = etag
    const res = await fetch(`${API}${path}`, { headers })
    return {
      status: res.status,
      etag: res.headers.get('etag') ?? undefined,
      pollInterval: num(res.headers.get('x-poll-interval')),
      rateLimit: num(res.headers.get('x-ratelimit-limit')),
      rateRemaining: num(res.headers.get('x-ratelimit-remaining')),
      rateReset: num(res.headers.get('x-ratelimit-reset')),
      body: res.status === 200 ? await res.json() as T : undefined
    }
  }
})

// owner/repo, or a github.com url (discord may wrap it in <>)
export const parseRepo = (text: string): string | undefined => {
  const m = text.trim().replace(/^<|>$/g, '')
    .match(/^(?:(?:https?:\/\/)?(?:www\.)?github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?(?:[/?#].*)?$/i)
  if (!m || !m[1] || !m[2] || m[2] === '.' || m[2] === '..') return undefined
  return `${m[1]}/${m[2]}`
}

export const shortSha = (sha: string): string => sha.slice(0, 7)

export const branchOf = (ref: string): string => ref.replace(/^refs\/heads\//, '')
