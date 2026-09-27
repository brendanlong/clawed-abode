import { describe, it, expect } from 'vitest';
import { stripMp3Metadata } from './mp3';

/** MPEG-2 Layer III, 64 kbps, 24 kHz, mono: 192-byte frames, as Kokoro emits. */
const FRAME_HEADER = [0xff, 0xf3, 0x84, 0xc4];
const FRAME_LENGTH = 192;
const MPEG2_MONO_SIDE_INFO = 9;

function frame(fill: number, tag?: string, tagOffset = 4 + MPEG2_MONO_SIDE_INFO): number[] {
  const bytes = [...FRAME_HEADER, ...new Array<number>(FRAME_LENGTH - 4).fill(fill)];
  if (tag) [...tag].forEach((c, i) => (bytes[tagOffset + i] = c.charCodeAt(0)));
  return bytes;
}

function id3v2(payloadLength: number): number[] {
  // Size is syncsafe: 7 bits per byte.
  const size = [21, 14, 7, 0].map((shift) => (payloadLength >> shift) & 0x7f);
  return [0x49, 0x44, 0x33, 4, 0, 0, ...size, ...new Array<number>(payloadLength).fill(0)];
}

const audio = [...frame(1), ...frame(2)];

describe('stripMp3Metadata', () => {
  it('leaves plain audio frames alone', () => {
    expect([...stripMp3Metadata(new Uint8Array(audio))]).toEqual(audio);
  });

  it.each(['Xing', 'Info'])('drops a leading %s frame', (tag) => {
    const input = new Uint8Array([...frame(0, tag), ...audio]);
    expect([...stripMp3Metadata(input)]).toEqual(audio);
  });

  it('drops a leading VBRI frame', () => {
    const input = new Uint8Array([...frame(0, 'VBRI', 36), ...audio]);
    expect([...stripMp3Metadata(input)]).toEqual(audio);
  });

  it('drops an ID3v2 tag and the VBR frame after it', () => {
    const input = new Uint8Array([...id3v2(300), ...frame(0, 'Xing'), ...audio]);
    expect([...stripMp3Metadata(input)]).toEqual(audio);
  });

  it('drops a trailing ID3v1 tag', () => {
    const tag = [0x54, 0x41, 0x47, ...new Array<number>(125).fill(0)];
    expect([...stripMp3Metadata(new Uint8Array([...audio, ...tag]))]).toEqual(audio);
  });

  it('returns input that is not MP3 unchanged', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5]);
    expect([...stripMp3Metadata(junk)]).toEqual([1, 2, 3, 4, 5]);
    expect(stripMp3Metadata(new Uint8Array())).toHaveLength(0);
  });
});
