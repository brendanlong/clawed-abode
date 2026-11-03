/**
 * Read-aloud audio travels from the TTS server through ours to the browser as
 * raw PCM: 16-bit little-endian mono at Kokoro's native 24 kHz.
 */
export const PCM_SAMPLE_RATE = 24_000;
export const PCM_BYTES_PER_SECOND = PCM_SAMPLE_RATE * 2;

/**
 * Converts 16-bit little-endian PCM bytes to samples in [-1, 1], piece by
 * piece. A sample split across pieces is carried over to the next.
 */
export async function* pcm16ToFloat32(
  bytes: AsyncIterable<Uint8Array>
): AsyncGenerator<Float32Array> {
  let carry: number | null = null;
  for await (const piece of bytes) {
    const offset = carry === null ? 0 : 1;
    const count = (piece.length + offset) >> 1;
    if (count === 0) {
      if (piece.length > 0) carry = piece[0];
      continue;
    }
    const samples = new Float32Array(count);
    const byteAt = (i: number) => (i < offset ? (carry as number) : piece[i - offset]);
    for (let i = 0; i < count; i++) {
      const value = byteAt(2 * i) | (byteAt(2 * i + 1) << 8);
      samples[i] = (value >= 0x8000 ? value - 0x10000 : value) / 0x8000;
    }
    const used = 2 * count - offset;
    carry = used < piece.length ? piece[used] : null;
    yield samples;
  }
}
