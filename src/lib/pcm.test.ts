import { describe, it, expect } from 'vitest';
import { pcm16ToFloat32 } from './pcm';

async function* from(...pieces: number[][]): AsyncGenerator<Uint8Array> {
  for (const piece of pieces) yield new Uint8Array(piece);
}

async function convert(...pieces: number[][]): Promise<number[][]> {
  const out: number[][] = [];
  for await (const samples of pcm16ToFloat32(from(...pieces))) out.push([...samples]);
  return out;
}

describe('pcm16ToFloat32', () => {
  it('reads little-endian signed samples scaled to [-1, 1]', async () => {
    expect(await convert([0x00, 0x00, 0x00, 0x40, 0x00, 0x80, 0xff, 0x7f])).toEqual([
      [0, 0.5, -1, 0x7fff / 0x8000],
    ]);
  });

  it('joins a sample split across pieces', async () => {
    expect(await convert([0x00, 0x00, 0x00], [0x40], [0x00], [0xc0, 0x00, 0x00])).toEqual([
      [0],
      [0.5],
      [-0.5, 0],
    ]);
  });

  it('drops a trailing odd byte and skips empty pieces', async () => {
    expect(await convert([], [0x00, 0x40, 0x01])).toEqual([[0.5]]);
  });
});
