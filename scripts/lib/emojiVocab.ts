import vocab from './emoji-vocab.json' with { type: 'json' }

export interface EmojiVocab {
  // primary emoji name -> emoji
  names: Record<string, string>
  // associated word -> emojis
  related: Record<string, string[]>
}

export const EMOJI_VOCAB: EmojiVocab = vocab
