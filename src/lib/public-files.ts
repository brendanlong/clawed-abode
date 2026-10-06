import { z } from 'zod';

/**
 * Browsers only attach the app's bearer token to its own fetches, so the public
 * files server authenticates with a copy of it in this cookie. Cookies ignore
 * ports, so the app sets it and the browser sends it to the other port.
 */
export const PUBLIC_AUTH_COOKIE = 'public_auth';

/**
 * `Set-Cookie` value for the public auth cookie; a null token clears it. HttpOnly
 * keeps it from the agent-written pages it unlocks.
 */
export function publicAuthCookie(token: string | null, maxAgeSeconds: number): string {
  const maxAge = token === null ? 0 : Math.floor(maxAgeSeconds);
  return `${PUBLIC_AUTH_COOKIE}=${token ?? ''}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * The public files server's login endpoint, which trades a one-time `code` from
 * the app for the cookie. Session ids are UUIDs, so it can't collide.
 */
export const PUBLIC_LOGIN_PATH = '/_login';

const NEXT_BASE = 'http://next.invalid';

/**
 * Where to send the browser after login: a same-origin path. Parsed rather than
 * prefix-checked, since browsers strip tabs and newlines and treat `\` as `/`
 * when resolving, and serialized so it is safe in a Location header.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw?.startsWith('/')) return '/';
  try {
    const url = new URL(raw, NEXT_BASE);
    return url.origin === NEXT_BASE ? url.pathname + url.search + url.hash : '/';
  } catch {
    return '/';
  }
}

/** Query parameter on the app's login page carrying the public path to return to. */
export const PUBLIC_NEXT_PARAM = 'public';

/**
 * The app's login page, set to bounce back to `next` on the public files server.
 * Passwords are only typed on the app's origin, never on the one serving
 * agent-written pages. The app is assumed to be on the public files server's
 * host at the default port (`tailscale serve`) unless APP_URL says otherwise.
 */
export function appSignInUrl(
  appUrl: string | undefined,
  publicBaseUrl: string,
  next: string
): string {
  const origin = new URL(appUrl ?? publicBaseUrl);
  if (!appUrl) origin.port = '';
  const url = new URL('/login', origin.origin);
  url.searchParams.set(PUBLIC_NEXT_PARAM, next);
  return url.toString();
}

export function publicLoginUrl(baseUrl: string, code: string, next: string): string {
  const url = new URL(PUBLIC_LOGIN_PATH, baseUrl);
  url.searchParams.set('code', code);
  url.searchParams.set('next', next);
  return url.toString();
}

/**
 * The path (with query and fragment) of a link into the public files server, or
 * null for links anywhere else — including its login endpoint, which needs no login.
 */
export function publicLinkPath(href: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseUrl).origin || url.pathname === PUBLIC_LOGIN_PATH) return null;
  return url.pathname + url.search + url.hash;
}

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

const PAGE_HEAD =
  '<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">';

/** Shown in place of any page the browser isn't signed in for. */
export function renderSignInPage(options: { signInUrl: string; expired?: boolean }): string {
  const message = options.expired
    ? 'That link has expired. Sign in to continue.'
    : 'Sign in to view this page.';
  return `<!doctype html>
<html>
<head>${PAGE_HEAD}<title>Sign in - Clawed Abode</title>
<style>body{font-family:system-ui,sans-serif;max-width:22rem;margin:4rem auto;padding:0 1rem;color-scheme:light dark}</style>
</head>
<body>
<h1>Clawed Abode</h1>
<p>${message}</p>
<p><a href="${escapeHtml(options.signInUrl)}">Sign in</a></p>
</body>
</html>
`;
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
<head>${PAGE_HEAD}<title>${escapeHtml(title)}</title></head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}
