/**
 * Speech is synthesized in chunks and streamed as one MP3, so each chunk's
 * file-level metadata has to go: a Xing/Info frame declares the frame count of
 * its own chunk, and a player that honors the first one stops after chunk one.
 */

const BITRATES_KBPS_MPEG1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BITRATES_KBPS_MPEG2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
/** Keyed by the header's 2-bit version field (1 is reserved). */
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  0: [11025, 12000, 8000],
};

const VBR_TAGS = ['Xing', 'Info'];
/** VBRI sits at a fixed offset after the frame header regardless of version. */
const VBRI_OFFSET = 4 + 32;

interface Layer3Frame {
  length: number;
  sideInfoLength: number;
}

function parseLayer3Frame(bytes: Uint8Array, offset: number): Layer3Frame | null {
  if (offset + 4 > bytes.length) return null;
  if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) return null;
  const version = (bytes[offset + 1] >> 3) & 0b11;
  const layer = (bytes[offset + 1] >> 1) & 0b11;
  const bitrateIndex = bytes[offset + 2] >> 4;
  const sampleRateIndex = (bytes[offset + 2] >> 2) & 0b11;
  if (version === 1 || layer !== 0b01 || bitrateIndex === 0 || bitrateIndex === 15) return null;
  if (sampleRateIndex === 3) return null;

  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? BITRATES_KBPS_MPEG1 : BITRATES_KBPS_MPEG2)[bitrateIndex] * 1000;
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  const padding = (bytes[offset + 2] >> 1) & 1;
  const mono = bytes[offset + 3] >> 6 === 0b11;
  return {
    length: Math.floor(((mpeg1 ? 144 : 72) * bitrate) / sampleRate) + padding,
    sideInfoLength: mpeg1 ? (mono ? 17 : 32) : mono ? 9 : 17,
  };
}

function asciiAt(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function id3v2Length(bytes: Uint8Array): number {
  if (bytes.length < 10 || asciiAt(bytes, 0, 3) !== 'ID3') return 0;
  const size =
    ((bytes[6] & 0x7f) << 21) |
    ((bytes[7] & 0x7f) << 14) |
    ((bytes[8] & 0x7f) << 7) |
    (bytes[9] & 0x7f);
  const hasFooter = (bytes[5] & 0x10) !== 0;
  return 10 + size + (hasFooter ? 10 : 0);
}

/**
 * The audio frames of an MP3 file, without a leading ID3v2 tag, a Xing/Info/VBRI
 * header frame, or a trailing ID3v1 tag. Returns a view, not a copy.
 */
export function stripMp3Metadata(bytes: Uint8Array): Uint8Array {
  let start = Math.min(id3v2Length(bytes), bytes.length);
  let end = bytes.length;
  if (end - start >= 128 && asciiAt(bytes, end - 128, 3) === 'TAG') end -= 128;

  const frame = parseLayer3Frame(bytes, start);
  if (frame) {
    const tagAt = start + 4 + frame.sideInfoLength;
    const isVbrHeader =
      VBR_TAGS.includes(asciiAt(bytes, tagAt, 4)) ||
      asciiAt(bytes, start + VBRI_OFFSET, 4) === 'VBRI';
    if (isVbrHeader) start = Math.min(start + frame.length, end);
  }
  return bytes.subarray(start, end);
}
