import { split, SentenceSplitterSyntax } from 'sentence-splitter';

/**
 * Longest speech request. Ordinary sentences stay whole; run-ons are broken at
 * clauses so no single request (and so no wait before its audio) grows long.
 */
export const MAX_CHUNK_CHARS = 300;

/** Split after clause punctuation (keeping it with the clause before). */
function splitAtClauseBoundaries(text: string): string[] {
  return text
    .split(/(?<=[,;:—–])\s+/)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** Greedily join `pieces` with spaces into chunks of at most `maxChars`. */
function pack(pieces: string[], maxChars: number): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const piece of pieces) {
    if (current && current.length + 1 + piece.length > maxChars) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current} ${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Break a sentence over `maxChars` at clause boundaries, falling back to word
 * boundaries for a clause that is still too long. A single word longer than
 * `maxChars` is kept whole.
 */
export function splitLongSentence(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  if (text.length <= maxChars) return [text];
  const pieces = splitAtClauseBoundaries(text).flatMap((clause) =>
    clause.length > maxChars ? pack(clause.split(/\s+/).filter(Boolean), maxChars) : [clause]
  );
  return pack(pieces, maxChars);
}

function splitSentences(line: string): string[] {
  const sentences = split(line)
    .filter((node) => node.type === SentenceSplitterSyntax.Sentence)
    .map((node) => line.slice(node.range[0], node.range[1]).trim())
    .filter((sentence) => sentence.length > 0);
  return sentences.length > 0 ? sentences : [line];
}

/**
 * Split text into speech requests of one sentence each (abbreviations like
 * "Dr." don't end one), with over-long sentences split further. Line breaks
 * also end a request, since in model output each line is a paragraph, list
 * item, or heading, usually without closing punctuation.
 */
export function splitIntoSpeechChunks(text: string, maxChars = MAX_CHUNK_CHARS): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap(splitSentences)
    .flatMap((sentence) => splitLongSentence(sentence, maxChars));
}
