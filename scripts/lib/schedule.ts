import type { Robot } from 'hubot'

import { randomId } from './random.ts'
import { HOUR_MS, MINUTE_MS, nextOccurrence } from './time.ts'
import type { Repeat } from './time.ts'

export interface Job<T> {
  id: string
  at: number
  tz: string
  repeat?: Repeat
  data: T
  // failed deliveries so far, for one-off jobs
  attempts?: number
}

export interface SchedulerOptions<T> {
  // repeats missed by up to this long still fire once on startup; later ones skip ahead
  missedGraceMs?: number
  // adjusts a repeat that skipped ahead over missed occurrences
  onMissed?: (job: Job<T>) => Job<T>
}

export interface Scheduler<T> {
  add: (job: Omit<Job<T>, 'id'> & { id?: string }) => Job<T>
  remove: (id: string) => boolean
  list: () => Job<T>[]
  get: (id: string) => Job<T> | undefined
}

// setTimeout overflows past ~24.8 days
const MAX_DELAY_MS = 2 ** 31 - 1
// recurring jobs missed by more than this skip ahead instead of firing late
export const MISSED_GRACE_MS = HOUR_MS
// one-off jobs whose handler throws (say, discord is down) are retried this often
export const RETRY_MS = MINUTE_MS
export const MAX_ATTEMPTS = 3

const isJob = (value: unknown): value is Job<unknown> =>
  typeof value === 'object' && value !== null &&
  typeof (value as Job<unknown>).id === 'string' &&
  typeof (value as Job<unknown>).at === 'number' &&
  typeof (value as Job<unknown>).tz === 'string'

// one brain listener per event for all schedulers, under the emitter's max-listener warning
const brainHooks = new WeakMap<Robot, Record<'connected' | 'close', (() => void)[]>>()

const onBrain = (robot: Robot, event: 'connected' | 'close', hook: () => void) => {
  let hooks = brainHooks.get(robot)
  if (!hooks) {
    const fresh = { connected: [] as (() => void)[], close: [] as (() => void)[] }
    robot.brain.on('connected', () => { for (const h of fresh.connected) h() })
    robot.brain.on('close', () => { for (const h of fresh.close) h() })
    brainHooks.set(robot, fresh)
    hooks = fresh
  }
  hooks[event].push(hook)
}

// brain-backed jobs under `schedule:<name>`; fire runs once per occurrence, repeats re-arm
export const scheduler = <T>(robot: Robot, name: string, fire: (job: Job<T>) => unknown, { missedGraceMs = MISSED_GRACE_MS, onMissed }: SchedulerOptions<T> = {}): Scheduler<T> => {
  const key = `schedule:${name}`
  const timers = new Map<string, NodeJS.Timeout>()

  const read = (): Job<T>[] => {
    const stored = robot.brain.get(key)
    return Array.isArray(stored) ? stored.filter(isJob) as Job<T>[] : []
  }
  const write = (jobs: Job<T>[]) => robot.brain.set(key, jobs)

  const disarm = (id: string) => {
    const timer = timers.get(id)
    if (timer) clearTimeout(timer)
    timers.delete(id)
  }

  const run = async (id: string) => {
    timers.delete(id)
    const job = read().find(j => j.id === id)
    if (!job) return
    if (job.at > Date.now()) {
      arm(job)
      return
    }
    // advance first so a throwing handler cannot refire forever
    const now = Date.now()
    if (job.repeat) {
      let at = nextOccurrence(job.repeat, job.tz, job.at)
      while (at <= now) at = nextOccurrence(job.repeat, job.tz, at)
      const next = { ...job, at }
      write(read().map(j => j.id === id ? next : j))
      arm(next)
    } else {
      write(read().filter(j => j.id !== id))
    }
    try {
      await fire(job)
    } catch (error) {
      robot.logger.error(`schedule ${name} job ${id} failed: ${String(error)}`)
      // retry unless the handler already scheduled a follow-up under this id
      const attempts = (job.attempts ?? 0) + 1
      if (!job.repeat && attempts < MAX_ATTEMPTS && !read().some(j => j.id === id)) {
        const retry = { ...job, at: Date.now() + RETRY_MS, attempts }
        write([...read(), retry])
        arm(retry)
      }
    }
  }

  const arm = (job: Job<T>) => {
    disarm(job.id)
    const delay = Math.min(Math.max(job.at - Date.now(), 0), MAX_DELAY_MS)
    const timer = setTimeout(() => { void run(job.id) }, delay)
    timer.unref()
    timers.set(job.id, timer)
  }

  const armAll = () => {
    const now = Date.now()
    const jobs = read().map(job => {
      if (!job.repeat || now - job.at <= missedGraceMs) return job
      let at = job.at
      while (at <= now) at = nextOccurrence(job.repeat, job.tz, at)
      const moved = { ...job, at }
      return onMissed ? onMissed(moved) : moved
    })
    write(jobs)
    for (const job of jobs) arm(job)
  }

  onBrain(robot, 'connected', armAll)
  onBrain(robot, 'close', () => { for (const id of [...timers.keys()]) disarm(id) })

  return {
    add: job => {
      const full: Job<T> = { ...job, id: job.id ?? randomId() }
      write([...read().filter(j => j.id !== full.id), full])
      arm(full)
      return full
    },
    remove: id => {
      disarm(id)
      const jobs = read()
      const kept = jobs.filter(j => j.id !== id)
      write(kept)
      return kept.length !== jobs.length
    },
    list: () => read().sort((a, b) => a.at - b.at),
    get: id => read().find(j => j.id === id)
  }
}
