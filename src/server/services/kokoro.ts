import { env } from '@/lib/env';
import type { KokoroVoice } from '@/lib/kokoro-voices';
import { SpeechStore } from './speech-store';

const REQUEST_TIMEOUT_MS = 60_000;

/** Synthesize text with the configured OpenAI-compatible `/audio/speech` endpoint. */
async function synthesizeMp3(text: string, voice: KokoroVoice, speed: number): Promise<Uint8Array> {
  const baseUrl = env.TTS_BASE_URL;
  if (!baseUrl) throw new Error('TTS_BASE_URL is not configured');

  const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/audio/speech`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.TTS_API_KEY ? { Authorization: `Bearer ${env.TTS_API_KEY}` } : {}),
    },
    // OpenRouter defaults to PCM, which can't be streamed to an <audio> element.
    body: JSON.stringify({
      model: env.TTS_MODEL,
      input: text,
      voice,
      speed,
      response_format: 'mp3',
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 500);
    throw new Error(`TTS provider returned ${response.status}: ${detail}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** 64 kbps MP3, so roughly two hours of replayable audio. */
const MAX_CACHED_BYTES = 64 * 1024 * 1024;
const SPEECH_TTL_MS = 60 * 60 * 1000;

let store: SpeechStore | null = null;

export function getSpeechStore(): SpeechStore {
  store ??= new SpeechStore({
    synthesize: synthesizeMp3,
    maxBytes: MAX_CACHED_BYTES,
    ttlMs: SPEECH_TTL_MS,
    maxInFlight: env.TTS_MAX_CONCURRENCY,
  });
  return store;
}
