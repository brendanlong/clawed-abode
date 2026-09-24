import { z } from 'zod';

/**
 * Browsers only attach the app's bearer token to its own fetches, so the public
 * files server authenticates with a copy of it in this cookie. Cookies ignore
 * ports, so the app sets it and the browser sends it to the other port.
 */
export const PUBLIC_AUTH_COOKIE = 'public_auth';

const sessionIdSchema = z.string().uuid();

export function publicFilesUrl(baseUrl: string, sessionId: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${sessionId}/`;
}

export interface PublicRequestPath {
  sessionId: string;
  /** Decoded path segments below the session's public dir; empty for its root. */
  segments: string[];
  trailingSlash: boolean;
}

/**
 * Parse `/{sessionId}/a/b` into its session and decoded segments. Returns null
 * for anything that could step outside the directory (`.`/`..`, encoded
 * slashes, NUL) so callers never join an unsafe segment onto a path.
 */
export function parsePublicRequestPath(pathname: string): PublicRequestPath | null {
  if (!pathname.startsWith('/')) return null;
  const [rawSessionId, ...rawSegments] = pathname.slice(1).split('/');
  const parsedSessionId = sessionIdSchema.safeParse(rawSessionId);
  if (!parsedSessionId.success) return null;

  const trailingSlash = rawSegments.length > 0 && rawSegments[rawSegments.length - 1] === '';
  const segments: string[] = [];
  for (const raw of trailingSlash ? rawSegments.slice(0, -1) : rawSegments) {
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (!isSafeSegment(segment)) return null;
    segments.push(segment);
  }
  return { sessionId: parsedSessionId.data, segments, trailingSlash };
}

export function parseCookie(header: string | undefined, name: string): string | null {
  for (const pair of header?.split(';') ?? []) {
    const eq = pair.indexOf('=');
    if (eq !== -1 && pair.slice(0, eq).trim() === name) {
      return pair.slice(eq + 1).trim() || null;
    }
  }
  return null;
}

function isSafeSegment(segment: string): boolean {
  return (
    segment !== '' &&
    segment !== '.' &&
    segment !== '..' &&
    !segment.includes('/') &&
    !segment.includes('\\') &&
    !segment.includes('\0')
  );
}

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  // Plain text so browsers display these instead of downloading them.
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  log: 'text/plain; charset=utf-8',
  csv: 'text/plain; charset=utf-8',
  tsv: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  pdf: 'application/pdf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
};

export function contentTypeFor(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  const ext = dot === -1 ? '' : fileName.slice(dot + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

export type ByteRange = { start: number; end: number };

/**
 * Parse a single-range `Range: bytes=…` header against a file size (iOS Safari
 * won't play video without range support). Returns null to serve the whole file
 * (no header, or a form we don't support, like multiple ranges) and
 * 'unsatisfiable' for a range entirely past the end.
 */
export function parseByteRange(
  header: string | null,
  size: number
): ByteRange | 'unsatisfiable' | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return null;

  if (rawStart === '') {
    const suffix = Number(rawEnd);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(rawStart);
  const end = rawEnd === '' ? size - 1 : Math.min(Number(rawEnd), size - 1);
  if (start >= size) return 'unsatisfiable';
  if (end < start) return null;
  return { start, end };
}

export interface DirectoryEntry {
  name: string;
  isDirectory: boolean;
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Minimal HTML index for a directory without an `index.html`. Links are relative, so the URL must end in `/`. */
export function renderDirectoryListing(title: string, entries: DirectoryEntry[]): string {
  const sorted = [...entries].sort(
    (a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name)
  );
  const items = sorted
    .map((entry) => {
      const suffix = entry.isDirectory ? '/' : '';
      const href = encodeURIComponent(entry.name) + suffix;
      return `<li><a href="${escapeHtml(href)}">${escapeHtml(entry.name + suffix)}</a></li>`;
    })
    .join('\n');
  const body = items ? `<ul>\n${items}\n</ul>` : '<p>This directory is empty.</p>';
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}
