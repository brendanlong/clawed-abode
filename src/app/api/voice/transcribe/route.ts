import { verifyApiAuth } from '@/lib/api-auth';
import { getOpenaiApiKey, transcribeAudio } from '@/server/services/voice';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:voice:transcribe');

export async function POST(req: Request) {
  const authenticated = await verifyApiAuth(req);
  if (!authenticated) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const apiKey = await getOpenaiApiKey();
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const formData = await req.formData();
    const audioBlob = formData.get('audio');

    if (!audioBlob || !(audioBlob instanceof File)) {
      return new Response(JSON.stringify({ error: 'No audio file provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const text = await transcribeAudio(audioBlob, apiKey);

    return new Response(JSON.stringify({ text }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    log.error('Transcription failed', error instanceof Error ? error : new Error(String(error)));
    return new Response(JSON.stringify({ error: 'Transcription failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
