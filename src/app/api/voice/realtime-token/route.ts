import { verifyApiAuth } from '@/lib/api-auth';
import { getOpenaiSettings } from '@/server/services/voice';
import { createLogger } from '@/lib/logger';
import OpenAI from 'openai';

const log = createLogger('api:voice:realtime-token');

export async function POST(req: Request) {
  const authenticated = await verifyApiAuth(req);
  if (!authenticated) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const openaiSettings = await getOpenaiSettings();
  if (!openaiSettings) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const openai = new OpenAI({ apiKey: openaiSettings.apiKey });

    const session = await openai.beta.realtime.transcriptionSessions.create({
      input_audio_format: 'pcm16',
      input_audio_transcription: {
        model: 'gpt-4o-mini-transcribe',
      },
      turn_detection: {
        type: 'server_vad',
        silence_duration_ms: 500,
        threshold: 0.5,
      },
    });

    log.info('Created realtime transcription session', {
      expiresAt: session.client_secret.expires_at,
    });

    return new Response(
      JSON.stringify({
        client_secret: session.client_secret.value,
        expires_at: session.client_secret.expires_at,
      }),
      {
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    log.error(
      'Failed to create realtime transcription session',
      error instanceof Error ? error : new Error(String(error))
    );
    return new Response(JSON.stringify({ error: 'Failed to create transcription session' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
