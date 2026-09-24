import { createReadStream } from 'fs';
import { Readable } from 'stream';
import type { NextRequest } from 'next/server';
import { prisma } from '@/lib/prisma';
import { resolveAuthSessionId } from '@/server/trpc';
import { resolvePublicTarget, type PublicFile } from '@/server/services/public-dir';
import {
  PUBLIC_AUTH_COOKIE,
  contentTypeFor,
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
      return serveFile(target.file, parsed.segments.at(-1) ?? '');
    case 'directory':
      // Relative links in the page resolve against the URL, so it must end in '/'.
      if (!parsed.trailingSlash) {
        return new Response(null, { status: 308, headers: { Location: `${pathname}/` } });
      }
      if (target.index) return serveFile(target.index, 'index.html');
      return new Response(renderDirectoryListing(pathname, target.entries), {
        headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      });
  }
}

function serveFile(file: PublicFile, name: string): Response {
  const body = Readable.toWeb(createReadStream(file.path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    headers: {
      'Content-Type': contentTypeFor(name),
      'Content-Length': String(file.size),
      // Agents overwrite files in place; always revalidate.
      'Cache-Control': 'no-cache',
    },
  });
}

function notFound(): Response {
  return new Response('Not found\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
