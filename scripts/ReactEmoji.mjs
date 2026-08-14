// Description:
//   Reacts with emoji based on message keywords and local sentiment tone. Discord only.
//

import { shuffle, chance } from './lib/random.mjs'
import { scoreTone } from './lib/sentiment.mjs'

const KEYWORD_EMOJI = {
  // animals
  pug: ['🐾', '🐕'],
  dog: ['🐶', '🐕'],
  puppy: ['🐶', '🐾'],
  cat: ['🐱', '🐈'],
  kitten: ['🐱', '🐈'],
  bird: ['🐦'],
  fish: ['🐟'],
  bear: ['🐻'],
  monkey: ['🐵'],
  snake: ['🐍'],
  spider: ['🕷️'],
  bug: ['🐛', '🪲'],

  // food & drink
  pizza: ['🍕'],
  coffee: ['☕'],
  tea: ['🍵'],
  beer: ['🍺', '🍻'],
  wine: ['🍷'],
  cake: ['🎂', '🍰'],
  taco: ['🌮'],
  burger: ['🍔'],
  fries: ['🍟'],
  sushi: ['🍣'],
  donut: ['🍩'],
  cookie: ['🍪'],
  ice: ['🧊'],
  icecream: ['🍦'],
  candy: ['🍬'],
  bacon: ['🥓'],

  // emotions & reactions
  love: ['❤️', '😍', '💕'],
  hate: ['😤'],
  congrats: ['🎉', '🥳'],
  congratulations: ['🎉', '🥳'],
  party: ['🎉', '🥳'],
  birthday: ['🎂', '🎉'],
  lol: ['😂', '🤣'],
  lmao: ['😂', '🤣'],
  rofl: ['🤣'],
  funny: ['😂', '😆'],
  hilarious: ['🤣'],
  sad: ['😢', '😭'],
  cry: ['😢', '😭'],
  crying: ['😢', '😭'],
  angry: ['😠', '😡'],
  mad: ['😠', '😡'],
  furious: ['😡'],
  happy: ['😄', '😊'],
  laugh: ['😂', '😆'],
  laughing: ['😂', '😆'],
  eyes: ['👀'],
  look: ['👀'],
  looking: ['👀'],
  watching: ['👀'],
  thanks: ['🙏', '🙌'],
  thank: ['🙏', '🙌'],
  please: ['🙏'],
  sorry: ['😔', '🙇'],
  oops: ['😅', '😬'],
  wow: ['😮', '😲'],
  amazing: ['😮', '🤩'],
  cool: ['😎'],
  awesome: ['🤩', '🔥'],
  scared: ['😱'],
  shocked: ['😱', '😲'],
  confused: ['😕', '🤔'],
  thinking: ['🤔'],
  bored: ['😑'],
  sick: ['🤒'],
  dead: ['💀'],
  lmaoo: ['💀', '😂'],
  facepalm: ['🤦'],
  shrug: ['🤷'],
  clap: ['👏'],
  salute: ['🫡'],

  // dev / work
  rocket: ['🚀'],
  ship: ['🚀'],
  shipped: ['🚀'],
  deploy: ['🚀'],
  deployed: ['🚀'],
  broken: ['💥', '🔥'],
  fixed: ['✅'],
  done: ['✅'],
  success: ['✅', '🎉'],
  fail: ['❌'],
  failed: ['❌'],
  error: ['❌', '🐛'],
  crash: ['💥'],
  crashed: ['💥'],
  warning: ['⚠️'],
  question: ['❓'],
  idea: ['💡'],
  review: ['👀'],
  approved: ['✅', '👍'],
  merged: ['🎉', '✅'],
  coding: ['💻'],
  code: ['💻'],
  computer: ['💻'],
  meeting: ['📅'],
  deadline: ['⏰'],
  urgent: ['🚨'],
  security: ['🔒'],
  bugfix: ['🐛', '✅'],
  test: ['🧪'],
  tests: ['🧪'],

  // money & achievement
  money: ['💰', '💸'],
  rich: ['💰'],
  win: ['🏆'],
  winner: ['🏆'],
  lose: ['😞'],
  loser: ['😞'],

  // weather & time
  fire: ['🔥'],
  rain: ['🌧️'],
  snow: ['❄️'],
  sun: ['☀️'],
  sunny: ['☀️'],
  hot: ['🥵'],
  cold: ['🥶'],
  storm: ['⛈️'],
  time: ['⏰'],
  late: ['⏰', '😅'],
  early: ['⏰'],

  // misc
  sleep: ['😴'],
  sleepy: ['😴'],
  tired: ['😴'],
  music: ['🎵', '🎶'],
  vote: ['🗳️'],
  poll: ['📊'],
  cheers: ['🥂'],
  yes: ['✅', '👍'],
  no: ['❌', '👎'],
  ok: ['👌'],
  okay: ['👌'],
  100: ['💯'],
  perfect: ['💯'],
  star: ['⭐'],
  starred: ['⭐'],
  hello: ['👋'],
  hi: ['👋'],
  hey: ['👋'],
  bye: ['👋'],
  goodbye: ['👋'],
  welcome: ['🎉', '👋']
}

export const SENTIMENT_EMOJI = {
  positive: [
    '🎉', '❤️', '🔥', '🥳', '😍', '👏', '💯', '🤩', '✨', '🙌',
    '😄', '😊', '💪', '🚀', '👍', '💕', '😻', '🏆', '💐', '🎊',
    '😎', '🙏', '💖', '🥰', '⭐'
  ],
  negative: [
    '😢', '😬', '😞', '😔', '😤', '😡', '😠', '💔', '😭', '😕',
    '😣', '👎', '😰', '😨', '🤦', '😩'
  ]
}

const MAX_REACTIONS_PER_MESSAGE = 5
const SKIP_CHANCE = 0.15

const HISTORY_KEY_PREFIX = 'reactemoji:history:'
const HISTORY_KEY = room => `${HISTORY_KEY_PREFIX}${room}`
const HISTORY_MAX_SIZE = 8

// stores only the numeric tone, never message text
const recordToneAndGetAverage = (robot, room, comparative) => {
  const history = robot.brain.get(HISTORY_KEY(room)) || []
  const updated = [...history, { comparative, ts: Date.now() }].slice(-HISTORY_MAX_SIZE)
  robot.brain.set(HISTORY_KEY(room), updated)
  return updated.reduce((sum, entry) => sum + entry.comparative, 0) / updated.length
}

export default async (robot) => {
  const pattern = new RegExp(`\\b(${Object.keys(KEYWORD_EMOJI).join('|')})\\b`, 'gi')

  // hears every message so sentiment can be scored, not just keyword matches
  robot.hear(/.*/, async res => {
    if (chance(SKIP_CHANCE)) return

    const message = res.message.user && res.message.user.message
    if (!message || typeof message.react !== 'function') return

    const text = res.message.text || ''
    const matches = text.match(pattern) || []
    const words = [...new Set(matches.map(w => w.toLowerCase()))]

    const { tone, comparative } = scoreTone(text)
    const average = recordToneAndGetAverage(robot, res.message.room, comparative)
    const sustained = (tone === 'positive' && average > 0) || (tone === 'negative' && average < 0)

    // one combined pool: tone sets the vibe, keywords add specific concepts
    const pool = [
      ...(sustained ? SENTIMENT_EMOJI[tone] : []),
      ...words.flatMap(word => KEYWORD_EMOJI[word.toLowerCase()])
    ]
    if (pool.length === 0) return

    const emojis = [...new Set(shuffle(pool))].slice(0, MAX_REACTIONS_PER_MESSAGE)

    for (const emoji of emojis) {
      await message.react(emoji)
    }
  })
}
