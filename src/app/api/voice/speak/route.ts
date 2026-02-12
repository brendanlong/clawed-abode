import { z } from 'zod';
import { verifyApiAuth } from '@/lib/api-auth';
import {
  getOpenaiApiKey,
  getAnthropicApiKey,
  needsTransformation,
  transformTextForSpeech,
  generateSpeech,
} from '@/server/services/voice';
import { createLogger } from '@/lib/logger';

const log = createLogger('api:voice:speak');

const speakInputSchema = z.object({
  text: z.string().min(1).max(100000),
  voice: z.string().optional(),
});

export async function POST(req: Request) {
  const authenticated = await verifyApiAuth(req);
  if (!authenticated) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const openaiKey = await getOpenaiApiKey();
  if (!openaiKey) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await req.json();
    const parsed = speakInputSchema.safeParse(body);

    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: 'Invalid input', details: parsed.error.flatten() }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    let { text } = parsed.data;
    const { voice } = parsed.data;

    // Optionally transform text for speech using Claude Sonnet
    if (needsTransformation(text)) {
      const anthropicKey = await getAnthropicApiKey();
      if (anthropicKey) {
        try {
          text = await transformTextForSpeech(text, anthropicKey);
        } catch (error) {
          // If transformation fails, fall back to raw text
          log.warn('Text transformation failed, using raw text', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    return await generateSpeech(text, openaiKey, voice);
  } catch (error) {
    log.error(
      'Speech generation failed',
      error instanceof Error ? error : new Error(String(error))
    );
    return new Response(JSON.stringify({ error: 'Speech generation failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
