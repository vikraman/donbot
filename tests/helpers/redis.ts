import { createClient } from 'redis'

// roomy search budget, parallel runs starve the 300ms default
process.env.AGDA_SEARCH_MS ??= '5000'

// redis 8 or skip
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL || 'redis://localhost:6379'

const probe = async (): Promise<string | false> => {
  const c = createClient({ url: TEST_REDIS_URL, socket: { connectTimeout: 1000, reconnectStrategy: false } })
  c.on('error', () => {})
  try {
    await c.connect()
    await c.sendCommand(['FT._LIST'])
    return false
  } catch (err) {
    return `no redis query engine at ${TEST_REDIS_URL}: ${(err as Error).message}`
  } finally {
    await c.disconnect().catch(() => {})
  }
}

export const noRedis = await probe()

// per-file key prefix
export const useTestRedis = (name: string) => {
  process.env.REDIS_URL = TEST_REDIS_URL
  process.env.AGDA_REDIS_PREFIX = `agdatest-${name}-${process.pid}`
}
