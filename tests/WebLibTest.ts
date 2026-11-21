import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { complete, inline, parse, placeholder, toText } from '../public/chat/lib.js'

const COMMANDS = [
  { cmd: 'joke', desc: 'Replies with a random dad joke.' },
  { cmd: 'joke <category>', desc: 'Replies with a joke from <category>.' },
  { cmd: 'help [query]', desc: 'Lists the commands available here.' },
  { cmd: 'ask wiki|ddg <question>', desc: 'Answers using one source.' },
  { cmd: 'xkcd', desc: 'Shows the latest xkcd.' }
]

describe('web chat rendering', () => {
  it('renders the markdown donbot writes', () => {
    assert.deepStrictEqual(inline('`donbot joke` – **bold** and *it* or _it_, ~~gone~~'), [
      { t: 'code', c: ['donbot joke'] }, ' – ', { t: 'b', c: ['bold'] }, ' and ', { t: 'i', c: ['it'] }, ' or ', { t: 'i', c: ['it'] }, ', ', { t: 's', c: ['gone'] }
    ])
    assert.deepStrictEqual(inline('[#7 Login \\[broken\\]](<https://github.com/o/r/issues/7>)'), [
      { t: 'a', href: 'https://github.com/o/r/issues/7', c: ['#7 Login ', '[', 'broken', ']'] }
    ])
    assert.deepStrictEqual(inline('see <https://e.com/x>, or https://i.imgur.com/a.png.'), [
      'see ', { t: 'a', href: 'https://e.com/x', c: ['https://e.com/x'], img: false }, ', or ',
      { t: 'a', href: 'https://i.imgur.com/a.png', c: ['https://i.imgur.com/a.png'], img: true }, '.'
    ])
  })
  it('leaves ordinary text alone', () => {
    assert.deepStrictEqual(inline('snake_case a * b C:\\Users'), ['snake_case a * b C:\\Users'])
    assert.deepStrictEqual(inline('an \\_escaped\\_ word'), ['an ', '_', 'escaped', '_', ' word'])
  })
  it('splits replies into code blocks, quotes and lines', () => {
    assert.deepStrictEqual(parse('one\n```\na *b*\n```\n> quoted'), [
      { t: 'p', c: ['one'] }, { t: 'pre', c: ['a *b*'] }, { t: 'q', c: ['quoted'] }
    ])
  })
  it('never makes links from anything but http(s), and keeps markup as text', () => {
    const nodes = inline('[x](javascript:alert(1)) <script>alert(1)</script>')
    assert.ok(nodes.every((n: unknown) => typeof n === 'string'))
    assert.strictEqual(nodes.join(''), '[x](javascript:alert(1)) <script>alert(1)</script>')
  })
  it('copies plain text with links spelled out', () => {
    assert.strictEqual(toText('**Standards** (#927)\n[comic](<https://xkcd.com/927>) and `code`'), 'Standards (#927)\ncomic (https://xkcd.com/927) and code')
  })
})

describe('web chat completion', () => {
  it('matches commands by what you type, expanding options and alternatives', () => {
    assert.deepStrictEqual(complete('jo', COMMANDS).map((c: { text: string }) => c.text), ['joke', 'joke <category>'])
    assert.deepStrictEqual(complete('he', COMMANDS).map((c: { text: string }) => c.text), ['help', 'help <query>'])
    assert.deepStrictEqual(complete('ask', COMMANDS).map((c: { text: string }) => c.text), ['ask wiki <question>', 'ask ddg <question>'])
    const agda = [{ cmd: 'agda help [types|patterns|filters|examples]', desc: '' }, { cmd: 'focus [<N> <unit>]', desc: '' }]
    assert.deepStrictEqual(complete('agda help', agda).map((c: { text: string }) => c.text), ['agda help types', 'agda help patterns', 'agda help filters', 'agda help examples'])
    assert.deepStrictEqual(complete('agda help e', agda).map((c: { text: string }) => c.text), ['agda help examples'])
    assert.deepStrictEqual(complete('focus', agda).map((c: { text: string }) => c.text), ['focus <N> <unit>'])
    assert.deepStrictEqual(complete('', COMMANDS), [])
    assert.deepStrictEqual(complete('zzz', COMMANDS), [])
  })
  it('puts past commands first, without repeats or what is already typed', () => {
    const picks = complete('jo', COMMANDS, ['xkcd', 'joke chuck', 'joke'])
    assert.deepStrictEqual(picks.map((c: { text: string, past: boolean }) => [c.text, c.past]), [['joke', true], ['joke chuck', true], ['joke <category>', false]])
    assert.deepStrictEqual(complete('joke', COMMANDS, []).map((c: { text: string }) => c.text), ['joke <category>'])
  })
  it('finds the placeholder to type over', () => {
    assert.deepStrictEqual(placeholder('joke <category>'), [5, 15])
    assert.strictEqual(placeholder('joke'), null)
  })
})
