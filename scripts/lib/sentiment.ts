import Sentiment from 'sentiment'

const analyzer = new Sentiment()

// raw score; comparative overweights short phrases
const POSITIVE_THRESHOLD = 3
const NEGATIVE_THRESHOLD = -3

export type Tone = 'positive' | 'negative' | 'neutral'

export interface ToneResult {
  score: number
  comparative: number
  tone: Tone
}

export const scoreTone = (text: string): ToneResult => {
  const { score, comparative } = analyzer.analyze(text)
  if (score >= POSITIVE_THRESHOLD) return { score, comparative, tone: 'positive' }
  if (score <= NEGATIVE_THRESHOLD) return { score, comparative, tone: 'negative' }
  return { score, comparative, tone: 'neutral' }
}
