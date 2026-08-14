import Sentiment from 'sentiment'

const analyzer = new Sentiment()

// raw score, not comparative: comparative overweights short phrases like "thanks"
const POSITIVE_THRESHOLD = 3
const NEGATIVE_THRESHOLD = -3

export const scoreTone = text => {
  const { score, comparative } = analyzer.analyze(text)
  if (score >= POSITIVE_THRESHOLD) return { score, comparative, tone: 'positive' }
  if (score <= NEGATIVE_THRESHOLD) return { score, comparative, tone: 'negative' }
  return { score, comparative, tone: 'neutral' }
}
