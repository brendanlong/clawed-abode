import { z } from 'zod';
import OpenAI from 'openai';
import { verifyApiAuth } from '@/lib/api-auth';
import {
  getOpenaiSettings,
  getAnthropicApiKey,
  needsTransformation,
  transformTextForSpeech,
  splitTextForTTS,
  generateSpeechChunk,
  ttsVoiceSchema,
} from '@/server/services/voice';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:voice:speak-stream');

const speakStreamInputSchema = z.object({
  text: z.string().min(1).max(100000),
  voice: ttsVoiceSchema.optional(),
});

function sseEvent(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = speakStreamInputSchema.safeParse(body);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: 'Invalid input', details: parsed.error.flatten() }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    );
  }

  let { text } = parsed.data;
  const voice = parsed.data.voice ?? 'nova';

  // Optionally transform text for speech using Claude Sonnet
  if (needsTransformation(text)) {
    const anthropicKey = await getAnthropicApiKey();
    if (anthropicKey) {
      try {
        text = await transformTextForSpeech(text, anthropicKey);
      } catch (error) {
        log.warn('Text transformation failed, using raw text', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  const chunks = splitTextForTTS(text);
  const openai = new OpenAI({ apiKey: openaiSettings.apiKey });
  const speed = openaiSettings.ttsSpeed;

  log.info('Starting speech stream', {
    textLength: text.length,
    totalChunks: chunks.length,
    voice,
    speed,
  });

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      try {
        // Send metadata event
        controller.enqueue(
          encoder.encode(
            sseEvent('metadata', { totalChunks: chunks.length, mimeType: 'audio/aac' })
          )
        );

        // Generate and stream each chunk
        for (let i = 0; i < chunks.length; i++) {
          try {
            const audioBuffer = await generateSpeechChunk(openai, chunks[i], voice, speed, 'aac');

            // Base64-encode the raw AAC data
            const base64 = Buffer.from(audioBuffer).toString('base64');

            controller.enqueue(encoder.encode(sseEvent('chunk', { index: i, audio: base64 })));
          } catch (error) {
            log.error(
              `TTS failed for chunk ${i}`,
              error instanceof Error ? error : new Error(String(error))
            );
            controller.enqueue(
              encoder.encode(sseEvent('error', { message: `TTS failed for chunk ${i}` }))
            );
            controller.close();
            return;
          }
        }

        // Signal completion
        controller.enqueue(encoder.encode(sseEvent('done', {})));
        controller.close();
      } catch (error) {
        log.error(
          'Speech stream failed',
          error instanceof Error ? error : new Error(String(error))
        );
        try {
          controller.enqueue(
            encoder.encode(sseEvent('error', { message: 'Speech stream failed' }))
          );
          controller.close();
        } catch {
          // Controller may already be closed
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
