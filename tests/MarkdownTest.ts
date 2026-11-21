import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { code, link, plain, splitMessage } from '../scripts/lib/markdown.ts'
import { unescapeMarkdown } from '../scripts/MessageGuard.ts'
import { fc } from './helpers/arb.ts'

describe('markdown', () => {
  it('leaves text that would not format alone', () => {
    assert.strictEqual(plain('fix snake_case parser (closes #12)'), 'fix snake_case parser (closes #12)')
    assert.strictEqual(plain('a * b | c ~ d'), 'a * b | c ~ d')
    assert.strictEqual(plain('C:\\Users\\x'), 'C:\\Users\\x')
    assert.strictEqual(plain('use `code` here'), 'use `code` here')
  })
  it('escapes markers that come in pairs', () => {
    assert.strictEqual(plain('add **bold** and ~~gone~~'), 'add \\*\\*bold\\*\\* and \\~\\~gone\\~\\~')
    assert.strictEqual(plain('_why_ not'), '\\_why\\_ not')
    assert.strictEqual(plain('x || spoiler || y'), 'x \\|\\| spoiler \\|\\| y')
    assert.strictEqual(plain('a [b](c) d'), 'a \\[b\\](c) d')
  })
  it('flattens lines, stops pings and previews', () => {
    assert.strictEqual(plain('one\n two'), 'one two')
    assert.strictEqual(plain('@everyone <@123> <#45>'), '@\u200beveryone <\u200b@123> <\u200b#45>')
    assert.strictEqual(plain('see https://x.io/a_b_c, then'), 'see <https://x.io/a_b_c>, then')
  })
  it('keeps link labels inside the link', () => {
    assert.strictEqual(link('a](x) [y]', 'https://e.com/a b'), '[a\\](x) \\[y\\]](<https://e.com/a%20b>)')
    assert.strictEqual(link('see https://x.io', 'https://e.com'), '[see https:\u200b//x.io](<https://e.com>)')
    assert.strictEqual(code('a`b'), "`a'b`")
  })
  it('splits long messages at line breaks, never mid-line', () => {
    const lines = Array.from({ length: 300 }, (_, i) => `line ${i} with some words`)
    const chunks = splitMessage(lines.join('\n'), 2000)
    assert.ok(chunks.length > 1)
    assert.ok(chunks.every(c => c.length <= 2000))
    assert.deepStrictEqual(chunks.join('\n').split('\n'), lines)
    assert.deepStrictEqual(splitMessage('short'), ['short'])
  })
  it('splits an overlong line at a space and reopens a cut code block', () => {
    const [a, b] = splitMessage(`${'word '.repeat(30)}end`, 100)
    assert.ok(a!.length <= 100 && !a!.endsWith(' ') && b!.endsWith('end'))
    const chunks = splitMessage(['```', ...Array.from({ length: 40 }, (_, i) => `code ${i}`), '```'].join('\n'), 120)
    assert.ok(chunks.length > 1)
    for (const c of chunks) assert.strictEqual((c.match(/```/g) ?? []).length % 2, 0, c)
  })
})

describe('markdown properties', () => {
  // markdown-heavy text
  const text = (chars: string[], maxLength = 80) => fc.array(fc.constantFrom(...chars), { maxLength }).map(cs => cs.join(''))
  const MARKS = ['a', 'b', ' ', '*', '_', '~', '|', '\\', '[', ']', '(', ')', '`']

  it('flattens to one line with no live pings', () => {
    const ping = fc.constantFrom('@everyone', '@HERE', '<@123>', '<#9>', '\n', '\t', 'x', ' ', 'https://a.b/c')
    fc.assert(fc.property(fc.array(ping, { maxLength: 20 }).map(p => p.join('')), raw => {
      const out = plain(raw)
      assert.doesNotMatch(out, /\n|@everyone|@here|<[@#]/i)
    }))
  })

  it('undoes plain with unescapeMarkdown', () => {
    // text plain escapes fully
    const flat = text(MARKS.filter(c => !'`()'.includes(c))).map(t => t.replace(/ +/g, ' ').trim())
    fc.assert(fc.property(flat, raw => {
      assert.strictEqual(unescapeMarkdown(plain(raw)), raw)
    }))
  })

  it('keeps inline code and link targets intact', () => {
    fc.assert(fc.property(text(MARKS), text([...MARKS, '<', '>', '/', ':']), (label, url) => {
      assert.strictEqual(code(label).match(/`/g)!.length, 2)
      assert.doesNotMatch(link(label, url).match(/\(<(.*)>\)$/s)![1]!, /[<> ]/)
    }))
  })

  it('splits within the limit, keeping fences balanced and every word', () => {
    const line = text(['a', 'b', ' ', '```', 'xyz'], 200)
    fc.assert(fc.property(fc.array(line, { maxLength: 40 }), fc.integer({ min: 40, max: 400 }), (lines, limit) => {
      // balanced input
      const input = lines.join('\n') + ((lines.join('').match(/```/g) ?? []).length % 2 ? '\n```' : '')
      const chunks = splitMessage(input, limit)
      const words = (t: string) => t.replace(/```/g, ' ').split(/\s+/).filter(Boolean)
      for (const chunk of chunks) {
        assert.ok(chunk.length <= limit, `${chunk.length} > ${limit}`)
        assert.strictEqual((chunk.match(/```/g) ?? []).length % 2, 0)
      }
      assert.deepStrictEqual(words(chunks.join('\n')), words(input))
    }))
  })
})
