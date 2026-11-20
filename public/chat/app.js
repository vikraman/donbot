import { complete, parse, placeholder, toText } from './lib.js'

const $ = id => document.getElementById(id)
const root = document.documentElement
const screen = $('screen'), form = $('form'), log = $('log'), input = $('input'), ghost = $('ghost'), list = $('complete'), chips = $('chips'), busy = $('busy')
const COMMANDS = JSON.parse($('commands').textContent || '[]')
const PALETTES = [['crimson', 'Crimson'], ['default', 'Default'], ['alpine', 'Alpine'], ['lilac', 'Lilac'], ['charcoal', 'Charcoal']]
const BACKDROPS = [['lattice', 'Lattice'], ['corduroy', 'Corduroy'], ['pinstripe', 'PinStripe'], ['none', 'None']]
const MAX_HISTORY = 200, MAX_EXCHANGES = 150, MAX_SAVED = 200_000

// storage may throw
const load = (k, d) => { try { return JSON.parse(localStorage.getItem(`donbot.${k}`)) ?? d } catch { return d } }
const save = (k, v) => { try { localStorage.setItem(`donbot.${k}`, JSON.stringify(v)) } catch {} }

let ws = load('ws', 1)
let history = load('history', [])
let exchanges = []
let browsing = -1, draft = ''
let picks = [], pick = 0
let pending = false

// tiny dom builder
const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...kids.flat(Infinity).filter(k => k != null))
  return el
}

const NODE = { b: 'b', i: 'i', s: 's', code: 'code', p: 'p', q: 'blockquote', pre: 'pre' }
const build = n => {
  if (typeof n === 'string') return n
  if (n.t === 'a') {
    const a = h('a', { href: n.href, target: '_blank', rel: 'noopener noreferrer' }, n.c.map(build))
    return n.img ? [a, h('img', { src: n.href, alt: '', loading: 'lazy' })] : a
  }
  return h(NODE[n.t], {}, n.c.map(build))
}

const copy = text => async e => {
  e.stopPropagation()
  const btn = e.currentTarget
  try { await navigator.clipboard.writeText(text); btn.textContent = 'copied' } catch { btn.textContent = 'select it' }
  setTimeout(() => { btn.textContent = 'copy' }, 1200)
}

const reply = (text, note) => note
  ? h('div', { className: 'out note' }, text)
  : h('div', { className: 'out' }, parse(text).map(build), h('button', { className: 'copy bevel', textContent: 'copy', onclick: copy(toText(text)) }))

const exchange = ({ cmd, replies = [], note }) => h('div', { className: 'ex' },
  cmd ? h('div', { className: 'cmd', textContent: cmd }) : null,
  replies.map(r => reply(r)), note ? reply(note, true) : null)

const motd = () => h('div', { className: 'motd' }, `workspace ${ws} · type `, h('b', { textContent: 'help' }), ', or press Tab to complete a command')
const bottom = () => { screen.scrollTop = screen.scrollHeight }

// a transcript per workspace
const show = n => {
  ws = n
  save('ws', ws)
  exchanges = load(`ws.${ws}`, [])
  log.replaceChildren(motd(), ...exchanges.map(exchange))
  root.dataset.workspace = ws
  document.querySelectorAll('[data-ws]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.ws) === ws)))
  bottom()
}
const remember = ex => {
  exchanges.push(ex)
  exchanges = exchanges.slice(-MAX_EXCHANGES)
  while (exchanges.length > 1 && JSON.stringify(exchanges).length > MAX_SAVED) exchanges.shift()
  save(`ws.${ws}`, exchanges)
}
const clear = () => { exchanges = []; save(`ws.${ws}`, []); show(ws) }

const send = async text => {
  if (pending) return
  if (text.toLowerCase() === 'clear') return clear()
  if (history.at(-1) !== text) history = [...history, text].slice(-MAX_HISTORY)
  save('history', history)
  const el = h('div', { className: 'ex' }, h('div', { className: 'cmd', textContent: text }), h('div', { className: 'out wait' }))
  log.append(el)
  bottom()
  // hide prompt while running
  pending = true
  form.hidden = true
  busy.classList.add('on')
  const ex = { cmd: text, replies: [] }
  try {
    const res = await fetch('/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) ex.note = res.status === 429 ? 'Slow down a little, then try again.' : body.error || `Something went wrong (${res.status}).`
    else if (!body.replies?.length) ex.note = 'No reply. `help` lists what I can do.'
    else ex.replies = body.replies
  } catch {
    ex.note = "Couldn't reach the server. Check your connection and try again."
  }
  pending = false
  busy.classList.remove('on')
  el.replaceWith(exchange(ex))
  remember(ex)
  form.hidden = false
  input.focus()
  bottom()
}

// ghost text, list, chips
const refresh = () => {
  const typed = input.value
  picks = complete(typed, COMMANDS, history)
  pick = 0
  const top = picks[0]
  const rest = top && top.text.toLowerCase().startsWith(typed.toLowerCase()) && input.selectionStart === typed.length ? top.text.slice(typed.length) : ''
  ghost.replaceChildren(h('span', { textContent: typed }), rest)
  list.hidden = picks.length < 2
  // flip up when no room
  list.classList.remove('up')
  list.replaceChildren(...picks.map((p, i) => h('div', {
    role: 'option', ariaSelected: String(i === pick), onmousedown: e => { e.preventDefault(); accept(i) }
  }, h('span', { textContent: p.text }), h('small', { textContent: p.desc }))))
  if (!list.hidden && list.getBoundingClientRect().bottom > screen.getBoundingClientRect().bottom) list.classList.add('up')
  const shown = typed ? picks.slice(0, 5) : ['help', ...new Set(history.slice().reverse())].slice(0, 5).map(text => ({ text }))
  chips.replaceChildren(
    h('button', { className: 'bevel', type: 'button', textContent: '↑', ariaLabel: 'Previous command', onclick: () => { recall(1); input.focus() } }),
    ...shown.map((p, i) => h('button', { className: 'bevel', type: 'button', textContent: p.text, onclick: () => { typed ? accept(i) : fill(p.text); input.focus() } })))
}
const select = i => {
  pick = (i + picks.length) % picks.length
  ;[...list.children].forEach((c, j) => c.setAttribute('aria-selected', String(j === pick)))
}
const fill = text => {
  input.value = text
  const ph = placeholder(text)
  ph ? input.setSelectionRange(...ph) : input.setSelectionRange(text.length, text.length)
  refresh()
}
const accept = i => { if (picks[i]) fill(picks[i].text) }

// history, keeping the draft
const recall = step => {
  if (!history.length) return
  if (browsing < 0) draft = input.value
  browsing = Math.max(-1, Math.min(history.length - 1, browsing + step))
  input.value = browsing < 0 ? draft : history[history.length - 1 - browsing]
  input.setSelectionRange(input.value.length, input.value.length)
  refresh()
}

input.addEventListener('input', () => { browsing = -1; refresh() })
input.addEventListener('keydown', e => {
  const open = !list.hidden
  if (e.key === 'Tab' && picks.length) { e.preventDefault(); accept(pick) }
  else if (e.key === 'ArrowRight' && picks.length && input.selectionStart === input.value.length && ghost.textContent.length > input.value.length) { e.preventDefault(); accept(0) }
  else if (e.key === 'ArrowUp') { e.preventDefault(); open ? select(pick - 1) : recall(1) }
  else if (e.key === 'ArrowDown') { e.preventDefault(); open ? select(pick + 1) : recall(-1) }
  else if (e.key === 'Escape') { list.hidden = true; ghost.replaceChildren() }
  else if (e.key === 'Enter' && open && pick > 0) { e.preventDefault(); accept(pick) }
  else if (e.key === 'l' && e.ctrlKey) { e.preventDefault(); clear() }
})
input.addEventListener('blur', () => { list.hidden = true })
$('form').addEventListener('submit', e => {
  e.preventDefault()
  const text = input.value.trim()
  if (!text) return
  input.value = ''
  browsing = -1
  refresh()
  send(text)
})

// style; only explicit choices are saved
const setPalette = (p, keep = true) => { root.dataset.palette = p; if (keep) save('style.palette', p) }
const setBackdrop = (b, keep = true) => { root.dataset.backdrop = b; if (keep) save('style.backdrop', b) }
const setSize = (px, keep = true) => { const s = Math.max(11, Math.min(22, px)); root.style.setProperty('--size', `${s}px`); if (keep) save('style.size', s) }
setPalette(load('style.palette', 'crimson'), false)
setBackdrop(load('style.backdrop', 'lattice'), false)
setSize(load('style.size', 14), false)

const keys = () => { remember({ note: 'Enter sends · Tab or → completes · ↑/↓ recall commands or pick from the list · Esc closes the list · Ctrl+L clears' }); show(ws) }
const forget = () => { history = []; save('history', []); refresh() }
const ACTIONS = { clear, help: () => send('help'), forget, keys }

// [label, action, checked], { label } or null
const MENUS = {
  window: () => [...[1, 2, 3, 4].map(n => [`Workspace ${['One', 'Two', 'Three', 'Four'][n - 1]}`, () => show(n), ws === n]), null, ['Clear workspace', clear], ['Forget command history', forget]],
  options: () => [{ label: 'Palette' }, ...PALETTES.map(([id, name]) => [name, () => setPalette(id), root.dataset.palette === id]),
    { label: 'Backdrop' }, ...BACKDROPS.map(([id, name]) => [name, () => setBackdrop(id), root.dataset.backdrop === id]),
    null, ['Larger text', () => setSize(parseInt(load('style.size', 14)) + 1)], ['Smaller text', () => setSize(parseInt(load('style.size', 14)) - 1)]],
  help: () => [['Commands', ACTIONS.help], ['Keys', keys]],
  style: () => MENUS.options().slice(0, -3),
  all: () => [...MENUS.window(), null, ...MENUS.options(), null, ...MENUS.help()]
}

let menu = null
const close = () => {
  menu?.remove()
  menu = null
  document.querySelectorAll('[aria-expanded="true"]').forEach(b => b.setAttribute('aria-expanded', 'false'))
}
const open = (anchor, name, className, title) => {
  close()
  const items = MENUS[name]().map(it => !it ? h('hr') : it.label ? h('div', { className: 'label', textContent: it.label })
    : h('button', { type: 'button', textContent: it[0], ariaChecked: String(Boolean(it[2])), onclick: () => { close(); it[1](); input.focus() } }))
  menu = h('div', { className }, title ? h('header', { textContent: title }) : null, items)
  anchor.setAttribute('aria-expanded', 'true')
  anchor.parentElement.append(menu)
}
document.querySelectorAll('.top').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation()
  menu && b.getAttribute('aria-expanded') === 'true' ? close() : open(b, b.dataset.menu, `drop bevel${b.dataset.menu === 'help' ? ' right' : ''}`)
}))
$('wmenu').addEventListener('click', e => { e.stopPropagation(); menu ? close() : open(e.currentTarget, 'all', 'drop bevel mobile') })
document.querySelectorAll('[data-sub]').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation()
  const slot = b.closest('.slot')
  menu && slot.contains(menu) ? close() : open(slot.querySelector('.tab'), b.dataset.sub, 'sub bevel', b.dataset.sub === 'style' ? 'Style Manager' : 'Help')
}))
document.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => { ACTIONS[b.dataset.act](); input.focus() }))
document.querySelectorAll('[data-ws]').forEach(b => b.addEventListener('click', () => { show(Number(b.dataset.ws)); input.focus() }))
document.addEventListener('click', close)
document.addEventListener('keydown', e => { if (e.key === 'Escape') close() })
$('max').addEventListener('click', () => document.body.classList.toggle('full'))
$('min').addEventListener('click', () => document.body.classList.add('iconic'))
$('restore').addEventListener('click', () => { document.body.classList.remove('iconic'); input.focus() })
screen.addEventListener('click', () => { if (!getSelection()?.toString()) input.focus() })

// world clock and calendar
const tick = () => {
  const d = new Date()
  $('minute').setAttribute('transform', `rotate(${d.getMinutes() * 6} 23 23)`)
  $('hour').setAttribute('transform', `rotate(${(d.getHours() % 12) * 30 + d.getMinutes() / 2} 23 23)`)
  $('cal').replaceChildren(h('span', { textContent: d.toLocaleDateString(undefined, { month: 'short' }) }), h('b', { textContent: d.getDate() }))
}
tick()
setInterval(tick, 15_000)

// prompt above the keyboard
const vv = window.visualViewport
const fit = () => root.style.setProperty('--vh', `${vv.height}px`)
if (vv) { vv.addEventListener('resize', () => { fit(); bottom() }); fit() }
input.addEventListener('focus', () => setTimeout(() => form.scrollIntoView({ block: 'nearest' }), 300))

show(ws)
refresh()
