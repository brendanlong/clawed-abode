import { z } from 'zod';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { prisma } from '@/lib/prisma';
import { decrypt } from '@/lib/crypto';
import { createLogger } from '@/lib/logger';

const log = createLogger('voice');

const GLOBAL_SETTINGS_ID = 'global';

const TTS_MAX_CHARS = 4096;

/**
 * Target chunk size for streaming TTS. Small enough for low-latency first audio
 * (~1-2 sentences), while still sending meaningful text to the TTS model.
 */
export const TTS_STREAM_TARGET_CHARS = 200;

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
 * Get the decrypted OpenAI API key and TTS speed from global settings.
 */
export async function getOpenaiSettings(): Promise<{ apiKey: string; ttsSpeed: number } | null> {
  const settings = await prisma.globalSettings.findUnique({
    where: { id: GLOBAL_SETTINGS_ID },
    select: { openaiApiKey: true, ttsSpeed: true },
  });

  if (!settings?.openaiApiKey) return null;
  return {
    apiKey: decrypt(settings.openaiApiKey),
    ttsSpeed: settings.ttsSpeed ?? 1.0,
  };
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
 * Split text at a word boundary, returning [chunk, remainder].
 * If no word boundary is found, splits at maxLength.
 */
export function splitTextAtWordBoundary(text: string, maxLength: number): [string, string] {
  if (text.length <= maxLength) {
    return [text, ''];
  }

  // Look for the last space within the limit
  const lastSpace = text.lastIndexOf(' ', maxLength);
  if (lastSpace > 0) {
    return [text.slice(0, lastSpace), text.slice(lastSpace + 1)];
  }

  // No word boundary found — hard split
  return [text.slice(0, maxLength), text.slice(maxLength)];
}

/**
 * Split text into chunks for TTS generation.
 *
 * @param text - The text to split.
 * @param targetSize - Target chunk size in characters. Defaults to TTS_MAX_CHARS (4096).
 *   For streaming TTS, pass TTS_STREAM_TARGET_CHARS (~200) for low-latency first audio.
 *   Chunks will generally be at or below this size, except when a single sentence
 *   exceeds it (sentences are never split unless they exceed the TTS API hard limit).
 *
 * Splitting hierarchy:
 * 1. Paragraph boundaries (\n\n)
 * 2. Sentence boundaries (after . ! ?)
 * 3. Word boundaries (last resort, only when a sentence exceeds TTS_MAX_CHARS)
 */
export function splitTextForTTS(text: string, targetSize: number = TTS_MAX_CHARS): string[] {
  const target = Math.min(targetSize, TTS_MAX_CHARS);

  if (text.length <= target) {
    return [text];
  }

  const chunks: string[] = [];
  const paragraphs = text.split(/\n\n+/);
  let current = '';

  for (const paragraph of paragraphs) {
    if (current.length + paragraph.length + 2 > target) {
      if (current) {
        chunks.push(current.trim());
        current = '';
      }
      // If a single paragraph exceeds the target, split it by sentences
      if (paragraph.length > target) {
        const sentences = paragraph.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (current.length + sentence.length + 1 > target) {
            if (current) {
              chunks.push(current.trim());
              current = '';
            }
            // Only split within a sentence if it exceeds the TTS API hard limit
            if (sentence.length > TTS_MAX_CHARS) {
              let remaining = sentence;
              while (remaining.length > TTS_MAX_CHARS) {
                const [chunk, rest] = splitTextAtWordBoundary(remaining, TTS_MAX_CHARS);
                chunks.push(chunk);
                remaining = rest;
              }
              if (remaining) {
                current = remaining;
              }
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

export const ttsVoiceSchema = z.enum(['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer']);
export type TTSVoice = z.infer<typeof ttsVoiceSchema>;
export type TTSFormat = 'mp3' | 'aac';

/**
 * Generate speech audio for a single text chunk via OpenAI TTS.
 * Returns raw audio data as an ArrayBuffer.
 */
export async function generateSpeechChunk(
  openai: OpenAI,
  text: string,
  voice: TTSVoice,
  speed: number,
  format: TTSFormat = 'mp3'
): Promise<ArrayBuffer> {
  const response = await openai.audio.speech.create({
    model: 'tts-1',
    voice,
    input: text,
    response_format: format,
    speed,
  });
  return response.arrayBuffer();
}

/**
 * Generate speech audio via OpenAI TTS.
 * Returns a Response with audio data (mp3 format).
 * For long text, chunks are generated sequentially and concatenated.
 */
export async function generateSpeech(
  text: string,
  apiKey: string,
  voice: string = 'nova',
  speed: number = 1.0
): Promise<Response> {
  const openai = new OpenAI({ apiKey });
  const chunks = splitTextForTTS(text);
  const ttsVoice = voice as TTSVoice;

  log.info('Generating speech', {
    textLength: text.length,
    chunks: chunks.length,
    voice,
    speed,
  });

  if (chunks.length === 1) {
    const audioBuffer = await generateSpeechChunk(openai, chunks[0], ttsVoice, speed, 'mp3');
    return new Response(audioBuffer, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Content-Length': String(audioBuffer.byteLength),
      },
    });
  }

  // For multiple chunks, generate all and concatenate
  const audioBuffers: ArrayBuffer[] = [];
  for (const chunk of chunks) {
    audioBuffers.push(await generateSpeechChunk(openai, chunk, ttsVoice, speed, 'mp3'));
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
