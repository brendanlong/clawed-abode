/**
 * Pure helpers for browser text-to-speech (SpeechSynthesis). Kept out of the
 * playback hook so the quirk-driven logic is unit-testable.
 */

/**
 * Chrome kills utterances over ~15 seconds (https://issues.chromium.org/issues/41294170),
 * so text is split into chunks of at most this many characters and spoken in sequence.
 */
export const CHUNK_MAX_LENGTH = 200;

const SENTENCE_ENDERS = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];

/**
 * Split text into chunks of at most {@link CHUNK_MAX_LENGTH} characters, preferring
 * to break at a sentence end, then a comma/semicolon, then a space, and only as a
 * last resort mid-word. Concatenating the chunks reproduces the input exactly.
 */
export function splitTextIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Every search starts at `CHUNK_MAX_LENGTH - delimiter.length` so the whole
    // delimiter lands inside the chunk; starting at CHUNK_MAX_LENGTH lets a match
    // begin at the cap and pushes the chunk past it.
    let bestEnder = { index: -1, length: 0 };
    for (const ender of SENTENCE_ENDERS) {
      // Compare raw indices; the offset is applied once, after the best one is known.
      const idx = remaining.lastIndexOf(ender, CHUNK_MAX_LENGTH - ender.length);
      if (idx > 0 && idx > bestEnder.index) bestEnder = { index: idx, length: ender.length };
    }
    let splitIndex = bestEnder.index > 0 ? bestEnder.index + bestEnder.length : -1;

    if (splitIndex <= 0) {
      const commaIdx = remaining.lastIndexOf(', ', CHUNK_MAX_LENGTH - 2);
      const semiIdx = remaining.lastIndexOf('; ', CHUNK_MAX_LENGTH - 2);
      splitIndex = Math.max(commaIdx, semiIdx);
      if (splitIndex > 0) splitIndex += 2;
    }

    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', CHUNK_MAX_LENGTH - 1);
      if (splitIndex > 0) splitIndex += 1;
    }

    if (splitIndex <= 0) {
      splitIndex = CHUNK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}

/** Voice fields the selection logic reads; a real SpeechSynthesisVoice satisfies it. */
export interface VoiceLike {
  voiceURI: string;
  lang: string;
  localService: boolean;
}

/** Normalize `en_US` to `en-US`; some engines report underscores. */
function normalizeLang(lang: string): string {
  return lang.replace('_', '-');
}

function primaryLang(lang: string): string {
  return normalizeLang(lang).split('-')[0];
}

/**
 * Pick the voice to speak with, in order: the user's explicit preference; a local
 * voice matching the full locale (e.g. `en-US`); a local voice matching the primary
 * language (`en`); any voice matching the primary language; the first voice. Null
 * only when no voices are loaded, in which case the browser default is used.
 */
export function selectVoice<V extends VoiceLike>(
  voices: readonly V[],
  preferredVoiceURI: string | null,
  locale: string
): V | null {
  const wanted = primaryLang(locale);
  return (
    (preferredVoiceURI ? voices.find((v) => v.voiceURI === preferredVoiceURI) : undefined) ??
    voices.find((v) => v.localService && normalizeLang(v.lang).startsWith(locale)) ??
    voices.find((v) => v.localService && primaryLang(v.lang) === wanted) ??
    voices.find((v) => primaryLang(v.lang) === wanted) ??
    voices[0] ??
    null
  );
}

/**
 * Voices for a picker: deduplicated by URI (some platforms report duplicates) and
 * sorted by language, then name.
 */
export function dedupeAndSortVoices<V extends VoiceLike & { name: string }>(
  voices: readonly V[]
): V[] {
  const seen = new Set<string>();
  return voices
    .filter((v) => !seen.has(v.voiceURI) && seen.add(v.voiceURI))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}
