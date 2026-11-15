import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { cooldown } from '../scripts/lib/cooldown.ts'

describe('cooldown', () => {
  it('should be ready for an unmarked key', () => {
    assert.ok(cooldown(1000).ready('a', 0))
  })

  it('should not be ready until the window has passed', () => {
    const c = cooldown(1000)
    c.mark('a', 0)
    assert.ok(!c.ready('a', 999))
    assert.ok(c.ready('a', 1000))
  })

  it('should keep keys independent', () => {
    const c = cooldown(1000)
    c.mark('a', 0)
    assert.ok(c.ready('b', 1))
  })

  it('should mark only when take succeeds', () => {
    const c = cooldown(1000)
    assert.ok(c.take('a', 0))
    assert.ok(!c.take('a', 500))
    // the failed take did not extend the window
    assert.ok(c.take('a', 1000))
  })

  it('should restart the window when a key is marked again', () => {
    const c = cooldown(1000)
    c.mark('a', 0)
    c.mark('b', 100)
    c.mark('a', 500)
    assert.ok(c.ready('b', 1100))
    assert.ok(!c.ready('a', 1100))
    assert.ok(c.ready('a', 1500))
  })
})
