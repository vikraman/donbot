import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { setupRobot, chat } from './helpers/setup.ts'

describe('DisableBuiltinHelp', () => {
  const state = setupRobot(['DisableBuiltinHelp.ts', 'Policy.ts', 'Count.ts'])

  it('shows comment-scraped commands instead of the built-in scaffolding', async () => {
    const { sent, ask } = chat(state)
    await ask('help')
    assert.match(sent[0]!, /\*\*Counter\*\*: `count`/)
    assert.doesNotMatch(sent[0]!, /No commands registered|Show commands with prefix/)
  })
})
