import { z } from 'zod';
import { createContext } from '@/server/trpc';
import { prisma } from '@/lib/prisma';
import {
  saveUploadedFile,
  MAX_UPLOAD_BYTES,
  MAX_TOTAL_UPLOAD_BYTES,
} from '@/server/services/uploads';
import { MAX_ATTACHMENTS, type UploadedAttachment } from '@/lib/attachments';
import { createLogger, toError } from '@/lib/logger';

const log = createLogger('upload-route');

const sessionIdSchema = z.string().uuid();

/**
 * Accepts multipart/form-data uploads (fields: `sessionId`, one or more `files`)
 * and stores them in the session workspace where Claude can read them. Returns
 * the saved attachments; the client holds these and passes their `storedName`s
 * to `claude.send`, which prefixes their paths onto the next user message.
 *
 * A dedicated route (rather than a tRPC mutation) is used so binary file bodies
 * stream through `FormData` instead of being base64-inflated through superjson.
 */
export async function POST(request: Request): Promise<Response> {
  const ctx = await createContext({ headers: request.headers });
  if (!ctx.sessionId) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Reject oversized requests before buffering the whole body into memory.
  // (App Router route handlers have no built-in body-size limit.)
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_TOTAL_UPLOAD_BYTES) {
    return Response.json(
      { error: `Upload exceeds the maximum total size of ${MAX_TOTAL_UPLOAD_BYTES} bytes` },
      { status: 413 }
    );
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    log.warn('Failed to parse upload form data', { error: toError(err).message });
    return Response.json({ error: 'Invalid form data' }, { status: 400 });
  }

  const parsedSessionId = sessionIdSchema.safeParse(formData.get('sessionId'));
  if (!parsedSessionId.success) {
    return Response.json({ error: 'A valid sessionId is required' }, { status: 400 });
  }
  const sessionId = parsedSessionId.data;

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

  const files = formData.getAll('files').filter((f): f is File => f instanceof File);
  if (files.length === 0) {
    return Response.json({ error: 'No files provided' }, { status: 400 });
  }
  if (files.length > MAX_ATTACHMENTS) {
    return Response.json(
      { error: `Too many files (max ${MAX_ATTACHMENTS} per upload)` },
      { status: 413 }
    );
  }

  // Validate sizes up front so we never write a partial batch.
  let total = 0;
  for (const file of files) {
    if (file.size > MAX_UPLOAD_BYTES) {
      return Response.json(
        { error: `File "${file.name}" exceeds the maximum size of ${MAX_UPLOAD_BYTES} bytes` },
        { status: 413 }
      );
    }
    total += file.size;
  }
  if (total > MAX_TOTAL_UPLOAD_BYTES) {
    return Response.json(
      { error: `Upload exceeds the maximum total size of ${MAX_TOTAL_UPLOAD_BYTES} bytes` },
      { status: 413 }
    );
  }

  const attachments: UploadedAttachment[] = [];
  for (const file of files) {
    const buffer = Buffer.from(await file.arrayBuffer());
    attachments.push(await saveUploadedFile(sessionId, file.name, buffer));
  }

  log.info('Handled file upload', { sessionId, count: attachments.length });
  return Response.json({ attachments });
}
