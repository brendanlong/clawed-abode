import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('voice');

const GLOBAL_SETTINGS_ID = 'global';

const TTS_MAX_CHARS = 4096;

const TRANSFORM_PROMPT = `You are converting markdown text into natural speech. The text will be read aloud by a text-to-speech system.

Rules:
- Convert tables into natural descriptions
- Describe code changes conversationally instead of reading code literally
- Expand abbreviations and acronyms
- Remove markdown formatting (links, bold, italic, headers)
- Keep the content concise — this is meant to be listened to
- Don't add any preamble like "Here's the speech version"
- Preserve the meaning and key information
- For short simple text without formatting, return it as-is`;

/**
 * Get the decrypted OpenAI API key from global settings.
 */
export async function getOpenaiApiKey(): Promise<string | null> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    select: { openaiApiKey: true },
  });

  if (!settings?.openaiApiKey) return null;
  return decrypt(settings.openaiApiKey);
}

/**
 * Get the decrypted Anthropic API key from global settings.
 */
export async function getAnthropicApiKey(): Promise<string | null> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    select: { claudeApiKey: true },
  });

  if (!settings?.claudeApiKey) return null;
  return decrypt(settings.claudeApiKey);
}

/**
 * Check if text contains markdown formatting that would benefit from transformation.
 */
export function needsTransformation(text: string): boolean {
  return /(\|.*\|.*\||```|^#{1,6}\s|^\s*[-*]\s|\[.*\]\(.*\))/m.test(text);
}

/**
 * Transcribe audio via OpenAI Whisper.
 */
export async function transcribeAudio(audioFile: File, apiKey: string): Promise<string> {
  const openai = new OpenAI({ apiKey });

  log.info('Transcribing audio', { size: audioFile.size, type: audioFile.type });

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'gpt-4o-mini-transcribe',
  });

  log.info('Transcription complete', { textLength: transcription.text.length });
  return transcription.text;
}

/**
 * Transform markdown text to speech-friendly text via Claude Sonnet.
 */
export async function transformTextForSpeech(text: string, apiKey: string): Promise<string> {
  const anthropic = new Anthropic({ apiKey });

  log.info('Transforming text for speech', { inputLength: text.length });

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 4096,
    system: TRANSFORM_PROMPT,
    messages: [{ role: 'user', content: text }],
  });

  const textBlock = response.content.find((block) => block.type === 'text');
  const result = textBlock && 'text' in textBlock ? textBlock.text : text;

  log.info('Text transformation complete', {
    inputLength: text.length,
    outputLength: result.length,
  });

  return result;
}

/**
 * Split text into chunks that fit within TTS character limits.
 * Splits on paragraph boundaries when possible.
 */
export function splitTextForTTS(text: string): string[] {
  if (text.length <= TTS_MAX_CHARS) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > TTS_MAX_CHARS) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      // If a single paragraph exceeds the limit, split it by sentences
      if (paragraph.length > TTS_MAX_CHARS) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 > TTS_MAX_CHARS) {
            if (current) {
              chunks.push(current.trim());
              current = '';
            }
            // If even a single sentence is too long, just truncate it
            if (sentence.length > TTS_MAX_CHARS) {
              chunks.push(sentence.slice(0, TTS_MAX_CHARS));
            } else {
              current = sentence;
            }
          } else {
            current += (current ? ' ' : '') + sentence;
          }
        }
      } else {
        current = paragraph;
      }
    } else {
      current += (current ? '\n\n' : '') + paragraph;
    }
  }

  if (current.trim()) {
    chunks.push(current.trim());
  }

  return chunks;
}

/**
 * Generate speech audio via OpenAI TTS.
 * Returns a ReadableStream of audio data (mp3 format).
 * For long text, chunks are generated sequentially and concatenated.
 */
export async function generateSpeech(
  text: string,
  apiKey: string,
  voice: string = 'nova'
): Promise<Response> {
  const openai = new OpenAI({ apiKey });
  const chunks = splitTextForTTS(text);

  log.info('Generating speech', { textLength: text.length, chunks: chunks.length, voice });

  if (chunks.length === 1) {
    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
      input: chunks[0],
      response_format: 'mp3',
    });

    return new Response(response.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
      },
    });
  }

  // For multiple chunks, generate all and concatenate
  const audioBuffers: ArrayBuffer[] = [];
  for (const chunk of chunks) {
    const response = await openai.audio.speech.create({
      model: 'tts-1',
      voice: voice as 'alloy' | 'echo' | 'fable' | 'onyx' | 'nova' | 'shimmer',
      input: chunk,
      response_format: 'mp3',
    });
    audioBuffers.push(await response.arrayBuffer());
  }

  const totalLength = audioBuffers.reduce((sum, buf) => sum + buf.byteLength, 0);
  const combined = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of audioBuffers) {
    combined.set(new Uint8Array(buf), offset);
    offset += buf.byteLength;
  }

  return new Response(combined, {
    headers: {
      'Content-Type': 'audio/mpeg',
      'Content-Length': String(totalLength),
    },
  });
}
