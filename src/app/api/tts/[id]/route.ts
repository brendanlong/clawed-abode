import { z } from 'zod';
import { parseByteRange } from '@/lib/byte-range';
import { getSpeechStore } from '@/server/services/kokoro';

const idSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const AUDIO_HEADERS = {
  'Content-Type': 'audio/mpeg',
  'Cache-Control': 'no-store',
};

/**
 * Audio minted by `POST /api/tts`. Unauthenticated: the id is the credential
 * (see doc/security.md). Streams while synthesis runs; once it is done the
 * length is known, so ranges are honored and players can seek.
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const id = idSchema.safeParse((await params).id);
  const speech = id.success ? getSpeechStore().get(id.data) : undefined;
  if (!speech || speech.failed) {
    return new Response(null, { status: 404 });
  }

  const complete = speech.complete();
  if (!complete) {
    return new Response(speech.stream(), { headers: AUDIO_HEADERS });
  }

  const range = parseByteRange(request.headers.get('range'), complete.length);
  if (range === 'unsatisfiable') {
    return new Response(null, {
      status: 416,
      headers: { 'Content-Range': `bytes */${complete.length}` },
    });
  }
  if (range) {
    return new Response(complete.slice(range.start, range.end + 1), {
      status: 206,
      headers: {
        ...AUDIO_HEADERS,
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${range.start}-${range.end}/${complete.length}`,
      },
    });
  }
  return new Response(complete, { headers: { ...AUDIO_HEADERS, 'Accept-Ranges': 'bytes' } });
}
