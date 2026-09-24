import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http';
import { open } from 'fs/promises';
import { pipeline } from 'stream/promises';
import { prisma } from '@/lib/prisma';
import { createLogger, toError } from '@/lib/logger';
import {
  PUBLIC_AUTH_COOKIE,
  contentTypeFor,
  parseByteRange,
  parseCookie,
  parsePublicRequestPath,
  renderDirectoryListing,
} from '@/lib/public-files';
import { resolveAuthSessionId } from './auth-sessions';
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
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { ...BASE_HEADERS, Allow: 'GET, HEAD' }).end();
    return;
  }

  const token = parseCookie(req.headers.cookie, PUBLIC_AUTH_COOKIE);
  if (!token || !(await resolveAuthSessionId(token))) {
    sendText(res, 401, 'Open Clawed Abode and sign in on this browser, then reload this page.\n');
    return;
  }

  const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
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

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { ...BASE_HEADERS, 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}
