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
//   GEMINI_MODELS - Comma-separated models to try in turn when one is busy. Defaults to gemini-flash-latest, gemini-flash-lite-latest, gemini-2.5-flash-lite.
//

import type { Robot } from 'hubot'

import { geminiText } from './lib/gemini.ts'
import { required } from './lib/match.ts'

type Source = 'gg' | 'ddg' | 'wiki'

interface AskResult {
  source: Source
  text: string
}

interface DuckDuckGoResponse {
  AbstractText?: string
  Answer?: string
  Definition?: string
}

interface WikipediaSearchResponse {
  query?: {
    search?: { title: string }[]
  }
}

interface WikipediaSummaryResponse {
  extract?: string
}

const TRAILING_PUNCTUATION = /[?!.]+$/
// \b keeps "do" from swallowing "does"
const QUESTION_PREFIX = /^(who|what|where|when|why|how)(?:['’](?:s|re)|\s+(?:is|are|was|were|do|does|did|can|could)\b)\s*(the\s+)?/i

const cleanForSearch = (question: string): string =>
  question.replace(TRAILING_PUNCTUATION, '').replace(QUESTION_PREFIX, '').trim()

const SOURCE_LABELS: Record<Source, string> = {
  gg: 'Gemini',
  ddg: 'DuckDuckGo',
  wiki: 'Wikipedia'
}

const withSource = (source: Source, text?: string): AskResult | null =>
  text ? { source, text } : null

const askGemini = async (question: string): Promise<AskResult | null> => {
  if (!process.env.GEMINI_API_KEY) return null
  try {
    const text = await geminiText({
      contents: [{ parts: [{ text: question }] }],
      systemInstruction: { parts: [{ text: 'Answer in 1-3 short sentences. No markdown formatting, headers, or bullet points.' }] },
      generationConfig: { maxOutputTokens: 1024 }
    })
    return withSource('gg', text ? text.trim() : undefined)
  } catch {
    // every model busy or failing; the next source takes over
    return null
  }
}

const askDuckDuckGo = async (question: string): Promise<AskResult | null> => {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(cleanForSearch(question))}&format=json&no_html=1&skip_disambig=1`
  const response = await fetch(url)
  const data: DuckDuckGoResponse = await response.json()
  return withSource('ddg', data.AbstractText || data.Answer || data.Definition || undefined)
}

const askWikipedia = async (question: string): Promise<AskResult | null> => {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanForSearch(question))}&srlimit=1&format=json`
  const searchResponse = await fetch(searchUrl)
  const searchData: WikipediaSearchResponse = await searchResponse.json()
  const title = searchData.query && searchData.query.search && searchData.query.search[0] && searchData.query.search[0].title
  if (!title) return null

  const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`
  const summaryResponse = await fetch(summaryUrl)
  if (!summaryResponse.ok) return null
  const data: WikipediaSummaryResponse = await summaryResponse.json()
  return withSource('wiki', data.extract || undefined)
}

const SOURCES: Record<Source, (question: string) => Promise<AskResult | null>> = {
  gg: askGemini,
  ddg: askDuckDuckGo,
  wiki: askWikipedia
}

const NO_ANSWER = "I don't have an answer for that."

const formatAnswer = (result: AskResult | null): string =>
  result ? `${result.text} [${SOURCE_LABELS[result.source]}]` : NO_ANSWER

export default async (robot: Robot) => {
  robot.respond(/ask (gg|ddg|wiki) (.+)$/i, { id: 'ask.source' }, async res => {
    const source = required(res.match, 1).toLowerCase() as Source
    const question = required(res.match, 2).trim()
    const result = await SOURCES[source](question)
    await res.send(formatAnswer(result))
  })

  robot.respond(/(?:please\s+)?ask (?!gg\s|ddg\s|wiki\s)(.+)$/i, { id: 'ask.question' }, async res => {
    const question = required(res.match, 1).trim()
    const result = await askGemini(question) || await askDuckDuckGo(question) || await askWikipedia(question)
    await res.send(formatAnswer(result))
  })

  robot.respond(/tell me about (.+)$/i, { id: 'ask.about' }, async res => {
    const question = required(res.match, 1).trim()
    const result = await askGemini(question) || await askDuckDuckGo(question) || await askWikipedia(question)
    await res.send(formatAnswer(result))
  })
}
