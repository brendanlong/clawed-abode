import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { open } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { z } from 'zod';
import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import { SESSION_DURATION_MS, loginSchema } from '@/lib/auth';
import { getClientIp } from '@/lib/client-ip';
import {
  PUBLIC_AUTH_COOKIE,
  PUBLIC_LOGIN_PATH,
  contentTypeFor,
  parseByteRange,
  parseCookie,
  parsePublicRequestPath,
  publicAuthCookie,
  renderDirectoryListing,
  renderLoginPage,
  safeNextPath,
} from '@/lib/public-files';
import { createAuthSession, resolveAuthSessionId } from './auth-sessions';
import { loginWithPassword, retryAfterMessage, type ClientInfo } from './password-login';
import { consumePublicLoginCode } from './public-login-codes';
import { resolvePublicTarget } from './public-dir';

const log = createLogger('public-files');

/**
 * Serves each session's `public/` directory at `/{sessionId}/…` on its own port.
 * A separate origin is the isolation: agent-written pages (and the CDN scripts
 * they pull in) can't read the app's localStorage token, without sandboxing
 * that would break `fetch()` and module scripts.
 */
export function createPublicFilesServer(): Server {
  return createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      // Clients abort mid-stream all the time (video seeking, navigating away).
      if (res.destroyed) {
        log.debug('Public file response aborted', { url: req.url });
        return;
      }
      log.error('Public file request failed', toError(err), { url: req.url });
      if (!res.headersSent) sendText(res, 500, 'Internal error\n');
      else res.destroy();
    });
  });
}

/** Loopback only: Tailscale Serve is the ingress, as for the app itself. */
export async function startPublicFilesServer(port: number): Promise<Server> {
  const server = createPublicFilesServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  log.info('Serving session public directories', { port });
  return server;
}

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  // The URL carries the session id; don't leak it to CDNs the page loads.
  'Referrer-Policy': 'no-referrer',
  // Agents overwrite files in place; always revalidate.
  'Cache-Control': 'no-cache',
};

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const { pathname } = url;
  if (pathname === PUBLIC_LOGIN_PATH) return handleLogin(req, res, url);

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' }).end();
    return;
  }

  if (!(await hasValidAuthCookie(req))) {
    return sendHtml(res, 401, renderLoginPage({ next: safeNextPath(pathname + url.search) }));
  }

  const parsed = parsePublicRequestPath(pathname);
  if (!parsed) return sendText(res, 404, 'Not found\n');

  const session = await prisma.session.findUnique({
    where: { id: parsed.sessionId },
    select: { status: true },
  });
  if (!session || session.status === 'archived') return sendText(res, 404, 'Not found\n');

  const target = await resolvePublicTarget(parsed.sessionId, parsed.segments);
  switch (target.kind) {
    case 'notFound':
      return sendText(res, 404, 'Not found\n');
    case 'file':
      return serveFile(req, res, target.path, parsed.segments.at(-1) ?? '');
    case 'directory':
      // Relative links in the page resolve against the URL, so it must end in '/'.
      if (!parsed.trailingSlash) {
        res.writeHead(308, { ...BASE_HEADERS, Location: `${pathname}/` }).end();
        return;
      }
      if (target.index !== null) return serveFile(req, res, target.index, 'index.html');
      res.writeHead(200, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
      res.end(req.method === 'HEAD' ? undefined : renderDirectoryListing(pathname, target.entries));
  }
}

const LOGIN_BODY_LIMIT_BYTES = 8 * 1024;

const loginFormSchema = loginSchema.extend({ next: z.string().optional() });

/**
 * Signs this browser in, by one-time code (a link tapped in the app) or password
 * (any other link), and redirects to `next`. Either way the browser gets its own
 * auth session: it may not share the app's cookies, as when an Android PWA opens
 * links in a different browser.
 */
async function handleLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const client: ClientInfo = {
    ipAddress: getClientIp((name) => firstHeader(req.headers[name])),
    userAgent: req.headers['user-agent'],
  };

  if (req.method === 'GET' || req.method === 'HEAD') {
    const next = safeNextPath(url.searchParams.get('next'));
    const code = url.searchParams.get('code');
    const codeValid = code !== null && consumePublicLoginCode(code);
    // A browser that already shares the app's cookie needs no new auth session.
    if (await hasValidAuthCookie(req)) return redirect(res, next);
    if (codeValid) {
      return redirect(res, next, await createAuthSession(client.ipAddress, client.userAgent));
    }
    const error = code === null ? undefined : 'That link has expired. Sign in to continue.';
    return sendHtml(res, 200, renderLoginPage({ next, error }));
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD, POST' }).end();
    return;
  }

  const body = await readBody(req, LOGIN_BODY_LIMIT_BYTES);
  if (body === null) return sendText(res, 413, 'Request too large\n');
  const form = loginFormSchema.safeParse(Object.fromEntries(new URLSearchParams(body)));
  const next = safeNextPath(form.success ? form.data.next : null);
  if (!form.success) {
    return sendHtml(res, 400, renderLoginPage({ next, error: 'Password is required.' }));
  }

  const result = await loginWithPassword(form.data.password, client);
  if (result.ok) return redirect(res, next, result.token);
  switch (result.reason) {
    case 'rate_limited':
      return sendHtml(
        res,
        429,
        renderLoginPage({ next, error: retryAfterMessage(result.retryAfterMs) })
      );
    case 'invalid_password':
      return sendHtml(res, 401, renderLoginPage({ next, error: 'Invalid password.' }));
    case 'not_configured':
    case 'bad_hash':
      return sendHtml(res, 500, renderLoginPage({ next, error: 'Login is misconfigured.' }));
  }
}

async function hasValidAuthCookie(req: IncomingMessage): Promise<boolean> {
  const token = parseCookie(req.headers.cookie, PUBLIC_AUTH_COOKIE);
  return token !== null && (await resolveAuthSessionId(token)) !== null;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The request body as text, or null if it exceeds `limit` bytes. */
async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) return null;
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** 303 so a POSTed login form becomes a GET of `next`; sets the auth cookie when given a token. */
function redirect(res: ServerResponse, location: string, token?: string): void {
  res
    .writeHead(303, {
      ...BASE_HEADERS,
      Location: location,
      ...(token ? { 'Set-Cookie': publicAuthCookie(token, SESSION_DURATION_MS / 1000) } : {}),
    })
    .end();
}

async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  filePath: string,
  name: string
): Promise<void> {
  let handle;
  try {
    handle = await open(filePath);
  } catch {
    return sendText(res, 404, 'Not found\n');
  }
  try {
    // Size from the open handle, so an agent replacing the file mid-request can't
    // make Content-Length disagree with the bytes streamed.
    const { size } = await handle.stat();
    const headers = {
      ...BASE_HEADERS,
      'Content-Type': contentTypeFor(name),
      'Accept-Ranges': 'bytes',
    };

    const range = parseByteRange(req.headers.range ?? null, size);
    if (range === 'unsatisfiable') {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` }).end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    res.writeHead(range ? 206 : 200, {
      ...headers,
      'Content-Length': String(end - start + 1),
      ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD' || size === 0) {
      res.end();
      return;
    }
    await pipeline(handle.createReadStream({ start, end, autoClose: false }), res);
  } finally {
    await handle.close();
  }
}

function sendHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
