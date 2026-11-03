import { env } from '@/lib/env';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { PCM_BYTES_PER_SECOND, PCM_SAMPLE_RATE, pcm16ToFloat32 } from '@/lib/pcm';
import { encodeAac } from './aac';
import { SpeechStore } from './speech-store';

/** Covers the whole response, body included; a chunk is at most a few sentences. */
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * A chunk is at most 300 characters, well under a minute even at half speed;
 * anything far past that is a misbehaving provider, not speech to buffer.
 */
const MAX_CHUNK_PCM_BYTES = 3 * 60 * PCM_BYTES_PER_SECOND;

/**
 * Synthesize text with the configured OpenAI-compatible `/audio/speech`
 * endpoint as raw PCM (24 kHz 16-bit little-endian mono), yielding it as it
 * streams in. PCM is the one format every server we use offers: OpenRouter and
 * Kokoro-FastAPI also do MP3, but optimized-kokoro only serves PCM.
 */
async function* synthesizePcm(
  text: string,
  voice: KokoroVoice,
  speed: number,
  signal: AbortSignal
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
    signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`TTS provider returned ${response.status}: ${detail}`);
  }
  if (!response.body) return;
  let bytes = 0;
  for await (const piece of response.body) {
    bytes += piece.length;
    if (bytes > MAX_CHUNK_PCM_BYTES) {
      throw new Error(`TTS provider returned over ${MAX_CHUNK_PCM_BYTES} bytes for one chunk`);
    }
    yield piece;
  }
}

/** AAC at about 53 kbps (ADTS headers included), so nearly three hours of replayable audio. */
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const SPEECH_TTL_MS = 60 * 60 * 1000;

let store: SpeechStore | null = null;

export function getSpeechStore(): SpeechStore {
  store ??= new SpeechStore({
    synthesize: synthesizePcm,
    encode: (pcm) => encodeAac(pcm16ToFloat32(pcm), PCM_SAMPLE_RATE),
    maxBytes: MAX_CACHED_BYTES,
    ttlMs: SPEECH_TTL_MS,
    maxInFlight: env.TTS_MAX_CONCURRENCY,
  });
  return store;
}
