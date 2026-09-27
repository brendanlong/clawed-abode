export interface ByteRange {
  start: number;
  /** Inclusive, as in the header. */
  end: number;
}

/**
 * The single range an HTTP `Range` header asks for within `size` bytes: null
 * when the header is absent or unusable (serve the whole body), 'unsatisfiable'
 * for a well-formed range entirely past the end. Multi-range requests are
 * served whole, which the spec allows.
 */
export function parseByteRange(
  header: string | null,
  size: number
): ByteRange | 'unsatisfiable' | null {
  const match = header?.trim().match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (match[1] === '' && match[2] === '')) return null;

  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  const start = Number(match[1]);
  const end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  if (start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end };
}
