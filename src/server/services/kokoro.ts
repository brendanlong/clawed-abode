import { env } from '@/lib/env';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { PCM_BYTES_PER_SECOND } from '@/lib/pcm';
import { SpeechStore } from './speech-store';

/** Covers the whole response, body included; a chunk is at most a few sentences. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Synthesize text with the configured OpenAI-compatible `/audio/speech`
 * endpoint as raw PCM (24 kHz 16-bit little-endian mono), yielding it as it
 * streams in. PCM is the one format every server we use offers: OpenRouter and
 * Kokoro-FastAPI also do MP3, but optimized-kokoro only serves PCM. The
 * browser encodes it for playback (see `src/lib/speech-encoding.ts`).
 */
async function* synthesizePcm(
  text: string,
  voice: KokoroVoice,
  speed: number
): AsyncGenerator<Uint8Array> {
  const baseUrl = env.TTS_BASE_URL;
  if (!baseUrl) throw new Error('TTS_BASE_URL is not configured');

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.TTS_API_KEY ? { Authorization: `Bearer ${env.TTS_API_KEY}` } : {}),
    },
    // No `stream` field: Kokoro-FastAPI and optimized-kokoro stream by default.
    body: JSON.stringify({
      model: env.TTS_MODEL,
      input: text,
      voice,
      speed,
      response_format: 'pcm',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`TTS provider returned ${response.status}: ${detail}`);
  }
  if (!response.body) return;
  yield* response.body;
}

/** About an hour and a half of replayable PCM. */
const MAX_CACHED_BYTES = 90 * 60 * PCM_BYTES_PER_SECOND;
const SPEECH_TTL_MS = 60 * 60 * 1000;

let store: SpeechStore | null = null;

export function getSpeechStore(): SpeechStore {
  store ??= new SpeechStore({
    synthesize: synthesizePcm,
    maxBytes: MAX_CACHED_BYTES,
    ttlMs: SPEECH_TTL_MS,
    maxInFlight: env.TTS_MAX_CONCURRENCY,
  });
  return store;
}
