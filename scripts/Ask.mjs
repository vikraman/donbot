// Description:
//   Answers a question via Gemini, DuckDuckGo, or Wikipedia (fallback chain or direct). Tags source.
//
// Commands:
//   hubot ask <question> - Answers <question>, trying Gemini, DuckDuckGo, then Wikipedia in turn.
//   hubot ask gg <question> - Answers <question> using Gemini only.
//   hubot ask ddg <question> - Answers <question> using DuckDuckGo only.
//   hubot ask wiki <question> - Answers <question> using Wikipedia only.
//   hubot tell me about <topic> - Same as hubot ask <topic>.
//
// Configuration:
//   GEMINI_API_KEY - API key for Gemini (https://aistudio.google.com/apikey). Optional; Gemini is skipped without it.
//

const TRAILING_PUNCTUATION = /[?!.]+$/
// \b keeps "do" from swallowing "does"
const QUESTION_PREFIX = /^(who|what|where|when|why|how)(?:['’](?:s|re)|\s+(?:is|are|was|were|do|does|did|can|could)\b)\s*(the\s+)?/i

const cleanForSearch = question =>
  question.replace(TRAILING_PUNCTUATION, '').replace(QUESTION_PREFIX, '').trim()

const SOURCE_LABELS = {
  gg: 'Gemini',
  ddg: 'DuckDuckGo',
  wiki: 'Wikipedia'
}

const withSource = (source, text) => text ? { source, text } : null

const askGemini = async (question) => {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: question }] }],
      systemInstruction: { parts: [{ text: 'Answer in 1-3 short sentences. No markdown formatting, headers, or bullet points.' }] },
      generationConfig: { maxOutputTokens: 1024 }
    })
  })
  if (!response.ok) return null
  const data = await response.json()
  const text = data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text
  return withSource('gg', text ? text.trim() : null)
}

const askDuckDuckGo = async (question) => {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanForSearch(question))}&format=json&no_html=1&skip_disambig=1`
  const response = await fetch(url)
  const data = await response.json()
  return withSource('ddg', data.AbstractText || data.Answer || data.Definition || null)
}

const askWikipedia = async (question) => {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanForSearch(question))}&srlimit=1&format=json`
  const searchResponse = await fetch(searchUrl)
  const searchData = await searchResponse.json()
  const title = searchData.query && searchData.query.search && searchData.query.search[0] && searchData.query.search[0].title
  if (!title) return null

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  const summaryResponse = await fetch(summaryUrl)
  if (!summaryResponse.ok) return null
  const data = await summaryResponse.json()
  return withSource('wiki', data.extract || null)
}

const SOURCES = {
  gg: askGemini,
  ddg: askDuckDuckGo,
  wiki: askWikipedia
}

const NO_ANSWER = "I don't have an answer for that."

const formatAnswer = result => result ? `${result.text} [${SOURCE_LABELS[result.source]}]` : NO_ANSWER

export default async (robot) => {
  robot.respond(/ask (gg|ddg|wiki) (.+)$/i, async res => {
    const source = res.match[1].toLowerCase()
    const question = res.match[2].trim()
    const result = await SOURCES[source](question)
    await res.send(formatAnswer(result))
  })

  robot.respond(/(?:please\s+)?ask (?!gg\s|ddg\s|wiki\s)(.+)$/i, async res => {
    const question = res.match[1].trim()
    const result = await askGemini(question) || await askDuckDuckGo(question) || await askWikipedia(question)
    await res.send(formatAnswer(result))
  })

  robot.respond(/tell me about (.+)$/i, async res => {
    const question = res.match[1].trim()
    const result = await askGemini(question) || await askDuckDuckGo(question) || await askWikipedia(question)
    await res.send(formatAnswer(result))
  })
}
