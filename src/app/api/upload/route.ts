import { z } from 'zod';
import { createContext } from '@/server/trpc';
import { prisma } from '@/lib/prisma';
import { saveUploadedFile } from '@/server/services/uploads';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('upload-route');

const querySchema = z.object({
  sessionId: z.string().uuid(),
  name: z.string().min(1).max(255),
});

/**
 * Accepts a single file as the raw request body (`?sessionId=…&name=…`) and
 * streams it into the session workspace where Claude can read it. Returns the
 * saved attachment; the client holds these and passes their `storedName`s to
 * `claude.send`, which prefixes their paths onto the next user message.
 *
 * A raw body (rather than a tRPC mutation or multipart form) lets the file go
 * straight to disk without being buffered in memory or base64-inflated.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const parsed = querySchema.safeParse({
    sessionId: searchParams.get('sessionId'),
    name: searchParams.get('name'),
  });
  if (!parsed.success) {
    return Response.json({ error: 'A valid sessionId and name are required' }, { status: 400 });
  }
  const { sessionId, name } = parsed.data;

  const session = await prisma.session.findUnique({
    where: { id: sessionId },
    select: { status: true },
  });
  if (!session) {
    return Response.json({ error: 'Session not found' }, { status: 404 });
  }
  // Uploads target the session workspace, which only exists while running.
  if (session.status !== 'running') {
    return Response.json({ error: 'Session is not running' }, { status: 409 });
  }

  try {
    const attachment = await saveUploadedFile(sessionId, name, request.body);
    return Response.json({ attachment });
  } catch (err) {
    log.error('Failed to save upload', toError(err), { sessionId });
    return Response.json({ error: 'Upload failed' }, { status: 500 });
  }
}
