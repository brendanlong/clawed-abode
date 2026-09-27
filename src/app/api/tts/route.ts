import { z } from 'zod';
import { createContext } from '@/server/trpc';
import { prisma } from '@/lib/prisma';
import { env } from '@/lib/env';
import { resolveKokoroVoice } from '@/lib/kokoro-voices';
import { getSpeechStore } from '@/server/services/kokoro';
import { GLOBAL_SETTINGS_ID } from '@/server/services/settings-scope';

const bodySchema = z.object({ text: z.string().trim().min(1).max(100_000) });

/**
 * Start (or reuse) synthesis of `text` with the saved voice and speed, and
 * return the URL an `<audio>` element plays it from. A media element can't send
 * the bearer header, so this authenticated POST mints the unguessable URL that
 * serves as the GET's credential. Responds once the first chunk is ready, so a
 * provider failure surfaces here rather than as an opaque media error.
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

  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    select: { ttsVoice: true, ttsSpeed: true },
  });
  const { id, speech } = getSpeechStore().open({
    text: parsed.data.text,
    voice: resolveKokoroVoice(settings?.ttsVoice),
    speed: settings?.ttsSpeed ?? 1.0,
  });

  try {
    await speech.ready();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Speech synthesis failed';
    return Response.json({ error: message }, { status: 502 });
  }
  return Response.json({ url: `/api/tts/${id}` });
}
