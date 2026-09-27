/**
 * Characters per speech request. Each request costs ~3-10 s of provider latency
 * whatever its length (measured on OpenRouter), and the next chunk is fetched
 * while one plays, so chunks are as long as a request comfortably takes.
 */
export const CHUNK_MAX_LENGTH = 1000;

const SENTENCE_ENDERS = ['. ', '! ', '? ', '.\n', '!\n', '?\n'];

/**
 * Split text into chunks of at most `maxLength` characters, preferring
 * to break at a sentence end, then a comma/semicolon, then a space, and only as a
 * last resort mid-word. Concatenating the chunks reproduces the input exactly.
 */
export function splitTextIntoChunks(text: string, maxLength = CHUNK_MAX_LENGTH): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // Every search starts at `maxLength - delimiter.length` so the whole
    // delimiter lands inside the chunk; starting at maxLength lets a match
    // begin at the cap and pushes the chunk past it.
    let bestEnder = { index: -1, length: 0 };
    for (const ender of SENTENCE_ENDERS) {
      // Compare raw indices; the offset is applied once, after the best one is known.
      const idx = remaining.lastIndexOf(ender, maxLength - ender.length);
      if (idx > 0 && idx > bestEnder.index) bestEnder = { index: idx, length: ender.length };
    }
    let splitIndex = bestEnder.index > 0 ? bestEnder.index + bestEnder.length : -1;

    if (splitIndex <= 0) {
      const commaIdx = remaining.lastIndexOf(', ', maxLength - 2);
      const semiIdx = remaining.lastIndexOf('; ', maxLength - 2);
      splitIndex = Math.max(commaIdx, semiIdx);
      if (splitIndex > 0) splitIndex += 2;
    }

    if (splitIndex <= 0) {
      splitIndex = remaining.lastIndexOf(' ', maxLength - 1);
      if (splitIndex > 0) splitIndex += 1;
    }

    if (splitIndex <= 0) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex);
  }

  return chunks;
}
