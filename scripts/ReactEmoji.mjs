// Description:
//   Reacts with emoji to messages based on common keywords they contain.
//   Discord only.
//

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

const MAX_REACTIONS_PER_MESSAGE = 5
const SKIP_CHANCE = 0.15

const shuffle = arr => {
  const copy = [...arr]
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]]
  }
  return copy
}

const pickEmoji = word => {
  const options = KEYWORD_EMOJI[word.toLowerCase()]
  return options[Math.floor(Math.random() * options.length)]
}

export default async (robot) => {
  const pattern = new RegExp(`\\b(${Object.keys(KEYWORD_EMOJI).join('|')})\\b`, 'gi')

  robot.hear(pattern, async res => {
    if (Math.random() < SKIP_CHANCE) return

    const message = res.message.user && res.message.user.message
    if (!message || typeof message.react !== 'function') return

    const matches = res.message.text.match(pattern) || []
    const words = [...new Set(matches.map(w => w.toLowerCase()))]
    const chosenWords = shuffle(words).slice(0, MAX_REACTIONS_PER_MESSAGE)
    const emojis = [...new Set(chosenWords.map(pickEmoji))]

    for (const emoji of emojis) {
      await message.react(emoji)
    }
  })
}
