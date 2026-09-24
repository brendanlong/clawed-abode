import { open } from 'fs/promises';
import { Readable } from 'stream';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveAuthSessionId } from '@/server/trpc';
import { resolvePublicTarget } from '@/server/services/public-dir';
import {
  PUBLIC_AUTH_COOKIE,
  contentTypeFor,
  parseByteRange,
  parsePublicRequestPath,
  renderDirectoryListing,
} from '@/lib/public-files';

/**
 * Serves `~/worktrees/{sessionId}/public/` as static files so agents can hand the
 * user a stable link instead of running their own HTTP server. Security headers
 * (the sandbox CSP in particular) come from next.config.js.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const token = request.cookies.get(PUBLIC_AUTH_COOKIE)?.value;
  if (!token || !(await resolveAuthSessionId(token))) {
    return new Response('Sign in to Clawed Abode, then reload this page.\n', {
      status: 401,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const pathname = request.nextUrl.pathname;
  const parsed = parsePublicRequestPath(pathname);
  if (!parsed) return notFound();

  const session = await prisma.session.findUnique({
    where: { id: parsed.sessionId },
    select: { status: true },
  });
  if (!session || session.status === 'archived') return notFound();

  const target = await resolvePublicTarget(parsed.sessionId, parsed.segments);
  switch (target.kind) {
    case 'notFound':
      return notFound();
    case 'file':
      return serveFile(target.path, parsed.segments.at(-1) ?? '', request);
    case 'directory':
      // Relative links in the page resolve against the URL, so it must end in '/'.
      if (!parsed.trailingSlash) {
        return new Response(null, { status: 308, headers: { Location: `${pathname}/` } });
      }
      if (target.index !== null) return serveFile(target.index, 'index.html', request);
      return new Response(renderDirectoryListing(pathname, target.entries), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
  }
}

async function serveFile(filePath: string, name: string, request: Request): Promise<Response> {
  let handle;
  try {
    handle = await open(filePath);
  } catch {
    return notFound();
  }
  // Size from the open handle, so an agent replacing the file mid-request can't
  // make Content-Length disagree with the bytes streamed.
  const { size } = await handle.stat();
  const headers: Record<string, string> = {
    'Content-Type': contentTypeFor(name),
    'Accept-Ranges': 'bytes',
    // Agents overwrite files in place; always revalidate.
    'Cache-Control': 'no-cache',
  };

  const range = parseByteRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    await handle.close();
    return new Response(null, {
      status: 416,
      headers: { ...headers, 'Content-Range': `bytes */${size}` },
    });
  }
  if (size === 0) {
    await handle.close();
    return new Response(null, { headers: { ...headers, 'Content-Length': '0' } });
  }

  const { start, end } = range ?? { start: 0, end: size - 1 };
  const body = Readable.toWeb(
    handle.createReadStream({ start, end })
  ) as ReadableStream<Uint8Array>;
  headers['Content-Length'] = String(end - start + 1);
  if (!range) return new Response(body, { headers });
  return new Response(body, {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}` },
  });
}

function notFound(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
