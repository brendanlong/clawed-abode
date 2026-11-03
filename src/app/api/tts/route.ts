import { z } from 'zod';
import { createContext } from '@/server/trpc';
import { env } from '@/lib/env';
import { DEFAULT_TTS_SPEED, resolveKokoroVoice } from '@/lib/kokoro-voices';
import { getSpeechStore } from '@/server/services/kokoro';
import { loadGlobalSettings } from '@/server/services/global-settings';

const bodySchema = z.object({ text: z.string().trim().min(1).max(100_000) });

/**
 * Speak `text` with the saved voice and speed, streaming raw PCM (see
 * `@/lib/pcm`) as it is synthesized; the browser encodes it for playback.
 * Repeats are served from the cache. Responds once the first chunk is ready,
 * so a provider failure arrives as a JSON error rather than a broken stream.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (!env.TTS_BASE_URL) {
    return Response.json({ error: 'Text-to-speech is not configured' }, { status: 404 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: 'A non-empty text field is required' }, { status: 400 });
  }

  const settings = await loadGlobalSettings();
  const speech = getSpeechStore().open({
    text: parsed.data.text,
    voice: resolveKokoroVoice(settings.ttsVoice),
    speed: settings.ttsSpeed ?? DEFAULT_TTS_SPEED,
  });

  try {
    await speech.ready();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Speech synthesis failed';
    return Response.json({ error: message }, { status: 502 });
  }
  return new Response(speech.stream(), {
    headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
  });
}
