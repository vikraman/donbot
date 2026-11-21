// gemini with model fallback

// tried in order on overload, rate limit, timeout or 404
export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'] as const

// slow replies count as busy, so the next model gets a turn
export const GEMINI_TIMEOUT_MS = 30 * 1000

// worth trying the next model
const SKIPPABLE = new Set([404, 429, 503])

// env override; GEMINI_LINE_MODELS is legacy
export const geminiModels = (): string[] => {
  const configured = (process.env.GEMINI_MODELS || process.env.GEMINI_LINE_MODELS || '').split(',').map(m => m.trim()).filter(Boolean)
  return configured.length ? configured : [...GEMINI_MODELS]
}

export class GeminiError extends Error {
  status: number
  constructor (status: number, message = `gemini responded ${status}`) {
    super(message)
    this.status = status
  }
}

export interface GeminiRequest {
  contents: { parts: { text: string }[] }[]
  systemInstruction?: { parts: { text: string }[] }
  generationConfig?: Record<string, unknown>
}

interface GeminiResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[]
}

export interface GeminiOptions {
  // before each request; false stops
  beforeCall?: () => boolean
  warn?: (message: string) => void
}

// first candidate's text, else GeminiError
export const geminiText = async (request: GeminiRequest, { beforeCall, warn }: GeminiOptions = {}): Promise<string | undefined> => {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) throw new GeminiError(0, 'no GEMINI_API_KEY')
  const body = JSON.stringify(request)
  let status = 0
  for (const model of geminiModels()) {
    if (beforeCall && !beforeCall()) {
      if (!status) throw new GeminiError(0, 'gemini request budget used up')
      break
    }
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
    let response: Response
    try {
      response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) })
    } catch (error) {
      warn?.(`gemini model ${model} failed: ${error instanceof Error ? error.name : String(error)}`)
      status = 503
      continue
    }
    if (response.ok) {
      const data = await response.json() as GeminiResponse
      return data.candidates?.[0]?.content?.parts?.[0]?.text
    }
    status = response.status
    if (!SKIPPABLE.has(status)) break
    if (status === 404) warn?.(`gemini model ${model} not found, skipping`)
  }
  throw new GeminiError(status)
}
