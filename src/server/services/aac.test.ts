import { describe, it, expect, vi } from 'vitest';
import { ADTS, ALL_FORMATS, BufferSource, Input } from 'mediabunny';
import { encodeAac } from './aac';

const RATE = 24_000;

function tone(samples: number): Float32Array {
  return Float32Array.from({ length: samples }, (_, i) => 0.3 * Math.sin(i / 10));
}

function concat(pieces: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const joined = new Uint8Array(pieces.reduce((sum, piece) => sum + piece.length, 0));
  let offset = 0;
  for (const piece of pieces) {
    joined.set(piece, offset);
    offset += piece.length;
  }
  return joined;
}

describe('encodeAac', () => {
  it('yields playable AAC-LC in ADTS while the speech is still arriving', async () => {
    const piece = RATE * 0.1;
    const totalPieces = 40; // 4 s
    let piecesGenerated = 0;
    async function* speech(): AsyncGenerator<Float32Array> {
      for (; piecesGenerated < totalPieces; piecesGenerated++) yield tone(piece);
    }

    const output: Uint8Array[] = [];
    let generatedAtFirstAudio: number | null = null;
    for await (const bytes of encodeAac(speech(), RATE)) {
      output.push(bytes);
      generatedAtFirstAudio ??= piecesGenerated;
    }

    // Within about a second of audio, not the whole 4 s.
    expect(generatedAtFirstAudio).not.toBeNull();
    expect(generatedAtFirstAudio!).toBeLessThan(totalPieces / 4);
    const input = new Input({ source: new BufferSource(concat(output)), formats: ALL_FORMATS });
    expect(await input.getFormat()).toBe(ADTS);
    const track = await input.getPrimaryAudioTrack();
    expect(await track?.getCodecParameterString()).toBe('mp4a.40.2');
    expect(track?.sampleRate).toBe(RATE);
    const duration = await input.computeDuration();
    // AAC pads the end to whole 1024-sample frames, plus its priming frame.
    expect(duration).toBeGreaterThanOrEqual(4 - 1 / RATE);
    expect(duration).toBeLessThanOrEqual(4 + (2 * 1024) / RATE);
  });

  it('stops pulling the speech as soon as its reader stops', async () => {
    let returned = false;
    let release!: () => void;
    const stalled = new Promise<void>((resolve) => (release = resolve));
    async function* speech(): AsyncGenerator<Float32Array> {
      try {
        for (let i = 0; i < 10; i++) yield tone(RATE * 0.1);
        await stalled;
        yield tone(RATE * 0.1);
      } finally {
        returned = true;
      }
    }

    for await (const bytes of encodeAac(speech(), RATE)) {
      if (bytes.length > 0) break;
    }
    await vi.waitFor(() => expect(returned).toBe(true), { timeout: 1000 });
    release();
  });
});
